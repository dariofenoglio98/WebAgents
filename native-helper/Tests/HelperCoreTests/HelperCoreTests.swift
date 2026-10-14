import Foundation
@testable import HelperCore
import Testing

final class FakeKeys: WrappingKeyStore {
    var stored: Data?
    var creations = 0
    var failRead = false
    init(_ stored: Data? = nil) { self.stored = stored }
    func existingKey() throws -> Data? {
        if failRead { throw HelperError("keychain_unavailable", "denied") }
        return stored
    }
    func create(_ key: Data) throws -> Data {
        creations += 1
        stored = key
        return key
    }
}

struct FakeOllama: OllamaInspector {
    var value = OllamaStatus(installed: true, version: "0.40.3", running: true, serverVersion: "0.40.3", origins: "chrome-extension://abcdefghijklmnopabcdefghijklmnop")
    func status(origin: String) -> OllamaStatus { value }
}

let origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
let masterKey = Data((0 ..< 32).map { UInt8($0) })

/// A deterministic counter as the random source.
func counter() -> (Int) -> Data {
    var next: UInt8 = 100
    return { count in
        Data((0 ..< count).map { _ in
            next &+= 1
            return next
        })
    }
}

func json(_ object: [String: Any]) -> Data {
    try! JSONSerialization.data(withJSONObject: object)
}

func code(_ reply: [String: Any]) -> String? {
    (reply["error"] as? [String: Any])?["code"] as? String
}

/// Feed `data` to a reader in chunks of at most `chunk` bytes, as a pipe may.
func reader(_ data: Data, chunk: Int = 3) -> (Int) -> Data {
    var offset = 0
    return { count in
        let end = min(data.count, offset + min(count, chunk))
        defer { offset = end }
        return data.subdata(in: offset ..< end)
    }
}

@Suite struct FramingTests {
    @Test func readsOneFrameAcrossShortReads() throws {
        let body = Data(#"{"op":"ollama.status"}"#.utf8)
        let result = Framing.readRequest(reader(Framing.frame(body)))
        #expect(try result.get() == body)
    }

    @Test func lengthIsLittleEndian() {
        let framed = Framing.frame(Data(repeating: 0x41, count: 258))
        #expect(Array(framed.prefix(4)) == [2, 1, 0, 0])
    }

    @Test func refusesOversizeUnread() {
        var length = UInt32(HelperLimits.maxRequestBytes + 1).littleEndian
        var data = Data(bytes: &length, count: 4)
        data.append(Data(repeating: 0x20, count: 10))
        var reads = 0
        let wrapped = reader(data)
        let result = Framing.readRequest { count in
            reads += 1
            return wrapped(count)
        }
        guard case let .failure(error) = result else { Issue.record("accepted"); return }
        #expect(error.code == "message_too_large")
        #expect(reads == 2) // the 4-byte header in two chunks of 3 and 1; the body is never read
    }

    @Test func acceptsExactlyTheLimit() {
        var length = UInt32(HelperLimits.maxRequestBytes).littleEndian
        var data = Data(bytes: &length, count: 4)
        data.append(Data(repeating: 0x20, count: HelperLimits.maxRequestBytes))
        #expect((try? Framing.readRequest(reader(data, chunk: 4096)).get())?.count == HelperLimits.maxRequestBytes)
    }

    @Test func refusesTruncatedAndEmpty() {
        let cases: [Data] = [Data(), Data([1, 0]), Data([0, 0, 0, 0]), Data([10, 0, 0, 0, 0x7B])]
        for input in cases {
            guard case let .failure(error) = Framing.readRequest(reader(input)) else { Issue.record("accepted \(Array(input))"); continue }
            #expect(error.code == "bad_frame")
        }
    }
}

@Suite struct OperationTests {
    @Test func wrapCreatesTheItemOnceAndUnwrapReturnsTheKey() throws {
        let keys = FakeKeys()
        let helper = Helper(keys: keys, ollama: FakeOllama(), random: counter())
        let wrapped = helper.handle(json(["op": "keychain.wrap", "key": masterKey.base64EncodedString()]), callerOrigin: origin)
        #expect(wrapped["ok"] as? Bool == true)
        #expect(wrapped["helper"] as? String == helperVersion)
        let blob = try #require(wrapped["blob"] as? String)
        #expect(Data(base64Encoded: blob)?.count == KeyWrap.blobBytes)
        #expect(!blob.contains(masterKey.base64EncodedString()))
        _ = helper.handle(json(["op": "keychain.wrap", "key": masterKey.base64EncodedString()]), callerOrigin: origin)
        #expect(keys.creations == 1)
        let unwrapped = helper.handle(json(["op": "keychain.unwrap", "blob": blob]), callerOrigin: origin)
        #expect(unwrapped["key"] as? String == masterKey.base64EncodedString())
    }

    /// The vector the extension's fake helper also asserts (`test/helpers/fake-helper.ts`): one blob format on both sides.
    @Test func wrapVector() throws {
        let blob = try KeyWrap.wrap(masterKey, kek: Data(repeating: 7, count: 32), nonce: Data(repeating: 1, count: 12))
        #expect(blob.base64EncodedString() == "AQEBAQEBAQEBAQEBAXbgi7SUuuoJ2d3WKnw6fj646gbnDIItBEAoWXl6qSiklWFlojL26FOkM5pYSQAR6A==")
    }

    @Test func unwrapWithoutTheItemIsNamed() throws {
        let helper = Helper(keys: FakeKeys(), ollama: FakeOllama(), random: counter())
        let blob = try KeyWrap.wrap(masterKey, kek: Data(repeating: 7, count: 32), nonce: Data(repeating: 1, count: 12))
        #expect(code(helper.handle(json(["op": "keychain.unwrap", "blob": blob.base64EncodedString()]), callerOrigin: origin)) == "keychain_item_missing")
    }

    @Test func unwrapUnderAnotherItemFails() throws {
        let helper = Helper(keys: FakeKeys(Data(repeating: 9, count: 32)), ollama: FakeOllama(), random: counter())
        let blob = try KeyWrap.wrap(masterKey, kek: Data(repeating: 7, count: 32), nonce: Data(repeating: 1, count: 12))
        #expect(code(helper.handle(json(["op": "keychain.unwrap", "blob": blob.base64EncodedString()]), callerOrigin: origin)) == "unwrap_failed")
    }

    @Test func tamperedBlobFails() throws {
        let kek = Data(repeating: 7, count: 32)
        var blob = try KeyWrap.wrap(masterKey, kek: kek, nonce: Data(repeating: 1, count: 12))
        blob[20] ^= 0x01
        #expect(throws: HelperError.self) { try KeyWrap.unwrap(blob, kek: kek) }
        var version = try KeyWrap.wrap(masterKey, kek: kek, nonce: Data(repeating: 1, count: 12))
        version[0] = 2
        #expect(throws: HelperError.self) { try KeyWrap.unwrap(version, kek: kek) }
    }

    @Test func keychainFailureIsReported() {
        let keys = FakeKeys()
        keys.failRead = true
        let helper = Helper(keys: keys, ollama: FakeOllama(), random: counter())
        #expect(code(helper.handle(json(["op": "keychain.wrap", "key": masterKey.base64EncodedString()]), callerOrigin: origin)) == "keychain_unavailable")
    }

    @Test func ollamaStatusReportsWhetherTheCallerIsAdmitted() {
        var ollama = FakeOllama()
        let helper = Helper(keys: FakeKeys(), ollama: ollama, random: counter())
        let reply = helper.handle(json(["op": "ollama.status"]), callerOrigin: origin)
        let status = reply["ollama"] as? [String: Any]
        #expect(status?["extension_allowed"] as? Bool == true)
        #expect(status?["version"] as? String == "0.40.3")
        ollama.value.origins = nil
        ollama.value.running = false
        ollama.value.serverVersion = nil
        let off = Helper(keys: FakeKeys(), ollama: ollama, random: counter()).handle(json(["op": "ollama.status"]), callerOrigin: origin)
        let offStatus = off["ollama"] as? [String: Any]
        #expect(offStatus?["extension_allowed"] as? Bool == false)
        #expect(offStatus?["running"] as? Bool == false)
        #expect(offStatus?["origins"] is NSNull)
    }

    /// The running server's answer wins over the launchd variable (T17 review 1, nit 6).
    @Test func theRunningServerDecidesWhetherTheCallerIsAdmitted() {
        var ollama = FakeOllama()
        ollama.value.serverAdmits = false // the variable admits us, the server (not restarted) does not
        let refused = Helper(keys: FakeKeys(), ollama: ollama, random: counter()).handle(json(["op": "ollama.status"]), callerOrigin: origin + "/")
        #expect((refused["ollama"] as? [String: Any])?["extension_allowed"] as? Bool == false)
        ollama.value.origins = nil
        ollama.value.serverAdmits = true // `ollama serve` with its own environment
        let admitted = Helper(keys: FakeKeys(), ollama: ollama, random: counter()).handle(json(["op": "ollama.status"]), callerOrigin: origin + "/")
        #expect((admitted["ollama"] as? [String: Any])?["extension_allowed"] as? Bool == true)
    }

    @Test func theInspectorGetsTheOriginAsChromeSendsIt() {
        final class Recording: OllamaInspector {
            var asked: [String] = []
            func status(origin: String) -> OllamaStatus {
                asked.append(origin)
                return FakeOllama().value
            }
        }
        let recording = Recording()
        _ = Helper(keys: FakeKeys(), ollama: recording, random: counter()).handle(json(["op": "ollama.status"]), callerOrigin: origin + "/")
        #expect(recording.asked == [origin])
    }

    @Test func originMatching() {
        #expect(Helper.originsAdmit("http://x, chrome-extension://*", origin))
        #expect(Helper.originsAdmit("*", origin))
        #expect(Helper.originsAdmit(origin + "/", origin))
        #expect(!Helper.originsAdmit("chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", origin))
        #expect(!Helper.originsAdmit("", origin))
    }
}

@Suite struct RefusalTests {
    let helper = Helper(keys: FakeKeys(), ollama: FakeOllama(), random: counter())

    func refused(_ body: Data) -> String? {
        let reply = helper.handle(body, callerOrigin: origin)
        #expect(reply["ok"] as? Bool == false)
        #expect(reply["key"] == nil && reply["blob"] == nil)
        return code(reply)
    }

    @Test func unknownOperations() {
        for op in ["keychain.read", "keychain.delete", "provider.key", "run", "ollama.install", "", "KEYCHAIN.WRAP"] {
            #expect(refused(json(["op": op])) == "unknown_operation")
        }
    }

    @Test func malformedMessages() {
        #expect(refused(Data("not json".utf8)) == "bad_json")
        #expect(refused(Data("[1,2]".utf8)) == "bad_request")
        #expect(refused(Data(#""ollama.status""#.utf8)) == "bad_json") // a bare string is no JSON document to Foundation
        #expect(refused(json(["operation": "ollama.status"])) == "bad_request")
        #expect(refused(json(["op": 3])) == "bad_request")
    }

    @Test func extraFieldsAreRefused() {
        #expect(refused(json(["op": "ollama.status", "path": "/etc/passwd"])) == "bad_request")
        #expect(refused(json(["op": "keychain.wrap", "key": masterKey.base64EncodedString(), "record": "x"])) == "bad_request")
        #expect(refused(json(["op": "keychain.unwrap", "blob": "AA==", "provider_key": "sk-x"])) == "bad_request")
    }

    @Test func badKeysAndBlobs() {
        #expect(refused(json(["op": "keychain.wrap"])) == "bad_request")
        #expect(refused(json(["op": "keychain.wrap", "key": 5])) == "bad_request")
        #expect(refused(json(["op": "keychain.wrap", "key": Data(repeating: 1, count: 31).base64EncodedString()])) == "bad_request")
        #expect(refused(json(["op": "keychain.wrap", "key": Data(repeating: 1, count: 33).base64EncodedString()])) == "bad_request")
        #expect(refused(json(["op": "keychain.wrap", "key": "!!!not base64!!!"])) == "bad_request")
        #expect(refused(json(["op": "keychain.wrap", "key": String(repeating: "A", count: 4000)])) == "bad_request")
        #expect(refused(json(["op": "keychain.unwrap", "blob": Data(repeating: 1, count: 60).base64EncodedString()])) == "bad_request")
    }

    @Test func repliesStayUnderTheLimit() {
        let big = Helper.encode(["ok": true, "pad": String(repeating: "x", count: HelperLimits.maxReplyBytes)])
        #expect(big.count <= HelperLimits.maxReplyBytes)
        let object = try? JSONSerialization.jsonObject(with: big) as? [String: Any]
        #expect(code(object ?? [:]) == "internal")
    }
}

@Suite struct CallerTests {
    let allowed = ["abcdefghijklmnopabcdefghijklmnop"]

    @Test func acceptsTheListedExtension() throws {
        #expect(try CallerOrigin.check(origin + "/", allowed: allowed) == allowed[0])
        #expect(try CallerOrigin.check(origin, allowed: allowed) == allowed[0])
    }

    @Test func refusesEverythingElse() {
        let bad: [String?] = [nil, "", "--version", "https://example.com/", "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/", "chrome-extension://abcdefghijklmnopabcdefghijklmnoz/", "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP/", "moz-extension://abcdefghijklmnopabcdefghijklmnop/"]
        for argument in bad {
            #expect(throws: HelperError.self) { try CallerOrigin.check(argument, allowed: allowed) }
        }
    }

    @Test func parsesTheIdListStrictly() throws {
        #expect(try CallerOrigin.allowedIds(Data(#"{"extension_ids":["abcdefghijklmnopabcdefghijklmnop"]}"#.utf8)) == allowed)
        for text in [#"{}"#, #"{"extension_ids":[]}"#, #"{"extension_ids":["x"]}"#, #"{"extension_ids":["abcdefghijklmnopabcdefghijklmnop"],"more":1}"#, "nope"] {
            #expect(throws: HelperError.self) { try CallerOrigin.allowedIds(Data(text.utf8)) }
        }
    }
}
