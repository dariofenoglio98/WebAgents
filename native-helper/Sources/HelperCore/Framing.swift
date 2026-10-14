import Foundation

/// The bounds of one exchange (D-204). Chrome allows 64 MiB towards a host and 1 MB back; the
/// helper's three operations need a few hundred bytes, so anything larger is refused unread.
public enum HelperLimits {
    public static let maxRequestBytes = 16 * 1024
    public static let maxReplyBytes = 4 * 1024
}

/// A refusal: a stable code the extension branches on and a sentence a person can read.
public struct HelperError: Error, Equatable {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// Chrome's native-messaging framing: a 4-byte length in native byte order (little-endian on
/// every Mac Chrome runs on), then that many bytes of UTF-8 JSON.
public enum Framing {
    /// Read one request through `read`, which returns up to `count` bytes or fewer at end of input.
    /// The body is never read when the declared length is zero or above the limit.
    public static func readRequest(_ read: (Int) -> Data) -> Result<Data, HelperError> {
        let header = readExactly(4, read)
        guard header.count == 4 else {
            return .failure(HelperError("bad_frame", "The message ended before its 4-byte length."))
        }
        let length = header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
        if length == 0 {
            return .failure(HelperError("bad_frame", "The message is empty."))
        }
        if Int(length) > HelperLimits.maxRequestBytes {
            return .failure(HelperError("message_too_large", "The message declares \(length) bytes; the helper reads at most \(HelperLimits.maxRequestBytes)."))
        }
        let body = readExactly(Int(length), read)
        guard body.count == Int(length) else {
            return .failure(HelperError("bad_frame", "The message ended after \(body.count) of its \(length) bytes."))
        }
        return .success(body)
    }

    /// Frame a reply: the length in little-endian order, then the payload.
    public static func frame(_ payload: Data) -> Data {
        var length = UInt32(payload.count).littleEndian
        var out = Data(bytes: &length, count: 4)
        out.append(payload)
        return out
    }

    private static func readExactly(_ count: Int, _ read: (Int) -> Data) -> Data {
        var out = Data()
        while out.count < count {
            let chunk = read(count - out.count)
            if chunk.isEmpty { break }
            out.append(chunk)
        }
        return out
    }
}
