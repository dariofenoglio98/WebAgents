import Foundation

public let helperVersion = "0.1.0"

/// Where the key-encryption key lives (the login keychain in the binary, a fake in tests).
public protocol WrappingKeyStore {
    /// The stored key, or nil when the item does not exist.
    func existingKey() throws -> Data?
    /// Store `key` as the item; when another process created one first, return that one instead.
    func create(_ key: Data) throws -> Data
}

/// What the helper reports about Ollama (D-204). Nothing here is secret.
public struct OllamaStatus: Equatable {
    public var installed: Bool
    public var version: String?
    public var running: Bool
    public var serverVersion: String?
    public var origins: String?

    public init(installed: Bool, version: String?, running: Bool, serverVersion: String?, origins: String?) {
        self.installed = installed
        self.version = version
        self.running = running
        self.serverVersion = serverVersion
        self.origins = origins
    }
}

public protocol OllamaInspector {
    func status() -> OllamaStatus
}

/// The three operations, and nothing else (D-204). Every request is validated against a closed
/// set of fields before anything is done.
public struct Helper {
    public static let operations: [String: Set<String>] = [
        "keychain.wrap": ["op", "key"],
        "keychain.unwrap": ["op", "blob"],
        "ollama.status": ["op"],
    ]

    let keys: WrappingKeyStore
    let ollama: OllamaInspector
    let random: (Int) -> Data

    public init(keys: WrappingKeyStore, ollama: OllamaInspector, random: @escaping (Int) -> Data) {
        self.keys = keys
        self.ollama = ollama
        self.random = random
    }

    /// Handle one request body from `callerOrigin` (already checked by the caller check) and
    /// return the reply object.
    public func handle(_ body: Data, callerOrigin: String) -> [String: Any] {
        do {
            let (op, request) = try Helper.parse(body)
            switch op {
            case "keychain.wrap":
                let key = try Helper.base64Field(request, "key", bytes: KeyWrap.keyBytes)
                let kek = try keys.existingKey() ?? keys.create(random(KeyWrap.keyBytes))
                let blob = try KeyWrap.wrap(key, kek: kek, nonce: random(KeyWrap.nonceBytes))
                return Helper.ok(op, ["blob": blob.base64EncodedString()])
            case "keychain.unwrap":
                let blob = try Helper.base64Field(request, "blob", bytes: KeyWrap.blobBytes)
                guard let kek = try keys.existingKey() else {
                    throw HelperError("keychain_item_missing", "This Mac's keychain holds no WebAgents item; unlock with the passphrase and turn keychain unlock on again.")
                }
                let key = try KeyWrap.unwrap(blob, kek: kek)
                return Helper.ok(op, ["key": key.base64EncodedString()])
            default: // "ollama.status"
                let status = ollama.status()
                var ollama: [String: Any] = [
                    "installed": status.installed,
                    "running": status.running,
                    "extension_allowed": Helper.originsAdmit(status.origins, callerOrigin),
                ]
                ollama["version"] = status.version ?? NSNull()
                ollama["server_version"] = status.serverVersion ?? NSNull()
                ollama["origins"] = status.origins ?? NSNull()
                return Helper.ok(op, ["ollama": ollama])
            }
        } catch let error as HelperError {
            return Helper.refusal(error)
        } catch {
            return Helper.refusal(HelperError("internal", "The helper failed: \(error)."))
        }
    }

    public static func ok(_ op: String, _ fields: [String: Any]) -> [String: Any] {
        var reply = fields
        reply["ok"] = true
        reply["op"] = op
        reply["helper"] = helperVersion
        return reply
    }

    public static func refusal(_ error: HelperError) -> [String: Any] {
        ["ok": false, "helper": helperVersion, "error": ["code": error.code, "message": error.message]]
    }

    /// Serialize a reply (sorted keys); a reply that would exceed the limit becomes a refusal.
    public static func encode(_ reply: [String: Any]) -> Data {
        let data = (try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])) ?? Data()
        if data.isEmpty || data.count > HelperLimits.maxReplyBytes {
            return (try? JSONSerialization.data(withJSONObject: refusal(HelperError("internal", "The reply could not be encoded within the limit.")), options: [.sortedKeys])) ?? Data("{}".utf8)
        }
        return data
    }

    static func parse(_ body: Data) throws -> (String, [String: Any]) {
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: body, options: [])
        } catch {
            throw HelperError("bad_json", "The message is not JSON.")
        }
        guard let request = value as? [String: Any] else {
            throw HelperError("bad_request", "The message must be a JSON object.")
        }
        guard let op = request["op"] as? String else {
            throw HelperError("bad_request", "The message names no operation.")
        }
        guard let allowed = operations[op] else {
            throw HelperError("unknown_operation", "The helper does three things only: \(operations.keys.sorted().joined(separator: ", ")).")
        }
        let extra = Set(request.keys).subtracting(allowed)
        if !extra.isEmpty {
            throw HelperError("bad_request", "\(op) takes no field \(extra.sorted().joined(separator: ", ")).")
        }
        return (op, request)
    }

    static func base64Field(_ request: [String: Any], _ name: String, bytes: Int) throws -> Data {
        guard let text = request[name] as? String else {
            throw HelperError("bad_request", "\(name) must be a base64 string.")
        }
        guard text.utf8.count <= 4 * ((bytes + 2) / 3), let data = Data(base64Encoded: text), data.count == bytes else {
            throw HelperError("bad_request", "\(name) must be \(bytes) bytes in base64.")
        }
        return data
    }

    /// Whether an `OLLAMA_ORIGINS` value admits `origin`: an exact entry, or the wildcards Ollama
    /// itself honours for extensions (`*`, `chrome-extension://*`). The trailing slash Chrome
    /// passes in `argv[1]` is not part of the origin.
    public static func originsAdmit(_ value: String?, _ origin: String) -> Bool {
        let wanted = normalizeOrigin(origin)
        guard let value else { return false }
        for entry in value.split(separator: ",") {
            let item = entry.trimmingCharacters(in: .whitespaces)
            if item == "*" || item == "chrome-extension://*" || normalizeOrigin(item) == wanted { return true }
        }
        return false
    }

    public static func normalizeOrigin(_ origin: String) -> String {
        origin.hasSuffix("/") ? String(origin.dropLast()) : origin
    }
}
