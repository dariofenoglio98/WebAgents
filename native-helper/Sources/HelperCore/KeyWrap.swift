import CryptoKit
import Foundation

/// The wrap of the store's master key under the helper's key-encryption key (D-204):
/// AES-256-GCM, blob = version byte 0x01 ‖ 12-byte nonce ‖ 32-byte ciphertext ‖ 16-byte tag.
/// The associated data names the purpose, so a blob sealed for anything else does not open.
public enum KeyWrap {
    public static let version: UInt8 = 1
    public static let keyBytes = 32
    public static let nonceBytes = 12
    public static let tagBytes = 16
    public static let blobBytes = 1 + nonceBytes + keyBytes + tagBytes
    public static let associatedData = Data("org.webagents.helper|keychain.wrap|v1".utf8)

    public static func wrap(_ key: Data, kek: Data, nonce: Data) throws -> Data {
        guard key.count == keyBytes, kek.count == keyBytes, nonce.count == nonceBytes else {
            throw HelperError("bad_request", "A key, a key-encryption key and a nonce of the expected sizes are required.")
        }
        let sealed = try AES.GCM.seal(key, using: SymmetricKey(data: kek), nonce: AES.GCM.Nonce(data: nonce), authenticating: associatedData)
        var blob = Data([version])
        blob.append(nonce)
        blob.append(sealed.ciphertext)
        blob.append(sealed.tag)
        return blob
    }

    public static func unwrap(_ blob: Data, kek: Data) throws -> Data {
        guard blob.count == blobBytes, blob.first == version, kek.count == keyBytes else {
            throw HelperError("unwrap_failed", "The blob is not one this helper wrote.")
        }
        let bytes = [UInt8](blob)
        let nonce = Data(bytes[1 ..< 1 + nonceBytes])
        let ciphertext = Data(bytes[1 + nonceBytes ..< 1 + nonceBytes + keyBytes])
        let tag = Data(bytes[(1 + nonceBytes + keyBytes)...])
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext, tag: tag)
            return try AES.GCM.open(box, using: SymmetricKey(data: kek), authenticating: associatedData)
        } catch {
            throw HelperError("unwrap_failed", "The blob does not open under this Mac's keychain item (it was wrapped elsewhere, or the item was replaced).")
        }
    }
}
