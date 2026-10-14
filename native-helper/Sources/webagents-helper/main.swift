// The WebAgents native helper (T17, D-204). Chrome starts it for one `sendNativeMessage`: it
// reads one framed request from stdin, writes one framed reply to stdout and exits. It refuses
// every request unless the caller is the WebAgents extension inside a Google-signed Chrome.
import Darwin
import Foundation
import HelperCore
import Security

/// The key-encryption key in the login keychain. The item's default access list trusts the
/// binary that created it (this helper); another program reading it gets the keychain prompt.
struct LoginKeychain: WrappingKeyStore {
    static let service = "org.webagents.helper"
    static let account = "store-wrapping-key"

    private var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: Self.account]
    }

    func existingKey() throws -> Data? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw HelperError("keychain_unavailable", "The keychain refused the read (\(Self.describe(status))).")
        }
        guard data.count == KeyWrap.keyBytes else {
            throw HelperError("keychain_unavailable", "The keychain item does not hold a key of the expected size.")
        }
        return data
    }

    func create(_ key: Data) throws -> Data {
        var item = base
        item[kSecValueData as String] = key
        item[kSecAttrLabel as String] = "WebAgents Agent Browser (store unlock)"
        item[kSecAttrDescription as String] = "Key-encryption key of the WebAgents native helper"
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem, let existing = try existingKey() { return existing }
        guard status == errSecSuccess else {
            throw HelperError("keychain_unavailable", "The keychain refused to store the item (\(Self.describe(status))).")
        }
        return key
    }

    static func describe(_ status: OSStatus) -> String {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "error"
        return "\(message), \(status)"
    }
}

/// The parent process must be Google Chrome, code-signed by Google (D-204). Chrome starts native
/// hosts from its browser process.
enum ParentCheck {
    static let requirement = """
    anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV" and \
    (identifier "com.google.Chrome" or identifier "com.google.Chrome.beta" or \
    identifier "com.google.Chrome.dev" or identifier "com.google.Chrome.canary")
    """

    static func verify() throws {
        let parent = getppid()
        guard parent > 1 else { throw HelperError("caller_refused", "The helper has no parent process.") }
        var code: SecCode?
        let attributes = [kSecGuestAttributePid: NSNumber(value: parent)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code else {
            throw HelperError("caller_refused", "The parent process's code signature cannot be read.")
        }
        var compiled: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, [], &compiled) == errSecSuccess, let compiled else {
            throw HelperError("internal", "The code requirement does not compile.")
        }
        guard SecCodeCheckValidity(code, [], compiled) == errSecSuccess else {
            throw HelperError("caller_refused", "The helper answers Google Chrome only.")
        }
    }
}

/// Ollama as this Mac has it: the app or the CLI, the local server, the launchd variable.
struct LocalOllama: OllamaInspector {
    func status() -> OllamaStatus {
        let files = FileManager.default
        let home = files.homeDirectoryForCurrentUser.path
        let apps = ["/Applications/Ollama.app", "\(home)/Applications/Ollama.app"]
        let clis = ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"]
        let app = apps.first { files.fileExists(atPath: $0) }
        let installed = app != nil || clis.contains { files.isExecutableFile(atPath: $0) }
        var version: String?
        if let app, let info = NSDictionary(contentsOfFile: "\(app)/Contents/Info.plist") {
            version = info["CFBundleShortVersionString"] as? String
        }
        let server = serverVersion()
        return OllamaStatus(installed: installed, version: version, running: server != nil, serverVersion: server, origins: launchdOrigins())
    }

    private func serverVersion() -> String? {
        guard let url = URL(string: "http://127.0.0.1:11434/api/version") else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        request.httpMethod = "GET"
        let done = DispatchSemaphore(value: 0)
        var version: String?
        URLSession(configuration: .ephemeral).dataTask(with: request) { data, response, _ in
            defer { done.signal() }
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data, data.count < 4096,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            version = (object["version"] as? String).map { String($0.prefix(64)) } ?? "unknown"
        }.resume()
        _ = done.wait(timeout: .now() + 3)
        return version
    }

    private func launchdOrigins() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["getenv", "OLLAMA_ORIGINS"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let value = String(decoding: data.prefix(1024), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

func randomBytes(_ count: Int) -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
        fatalError("SecRandomCopyBytes failed")
    }
    return Data(bytes)
}

func reply(_ object: [String: Any]) -> Never {
    FileHandle.standardOutput.write(Framing.frame(Helper.encode(object)))
    exit((object["ok"] as? Bool) == true ? 0 : 1)
}

/// The installed `extension-ids.json` beside the binary (D-203).
func allowedIds() throws -> [String] {
    let binary = (Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])).resolvingSymlinksInPath()
    let file = binary.deletingLastPathComponent().appendingPathComponent("extension-ids.json")
    guard let data = FileManager.default.contents(atPath: file.path), data.count < 4096 else {
        throw HelperError("caller_refused", "The helper's list of extension ids is missing; reinstall the helper.")
    }
    return try CallerOrigin.allowedIds(data)
}

do {
    let arguments = CommandLine.arguments
    if arguments.count == 2, arguments[1] == "--version" {
        print("webagents-helper \(helperVersion)")
        exit(0)
    }
    let id = try CallerOrigin.check(arguments.count > 1 ? arguments[1] : nil, allowed: allowedIds())
    try ParentCheck.verify()
    let body: Data
    switch Framing.readRequest({ FileHandle.standardInput.readData(ofLength: $0) }) {
    case let .success(data): body = data
    case let .failure(error): reply(Helper.refusal(error))
    }
    let helper = Helper(keys: LoginKeychain(), ollama: LocalOllama(), random: randomBytes)
    reply(helper.handle(body, callerOrigin: "chrome-extension://\(id)"))
} catch let error as HelperError {
    reply(Helper.refusal(error))
} catch {
    reply(Helper.refusal(HelperError("internal", "The helper failed: \(error).")))
}
