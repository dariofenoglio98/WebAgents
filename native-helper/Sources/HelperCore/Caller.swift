import Foundation

/// The caller check's first half (D-204): the origin Chrome passes as `argv[1]` must name one of
/// the extension ids the installer wrote. The second half (the parent's code signature) needs the
/// Security framework and lives in the executable.
public enum CallerOrigin {
    /// Parse `extension-ids.json` (`{"extension_ids": ["<32 letters a–p>", …]}`) strictly.
    public static func allowedIds(_ data: Data) throws -> [String] {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["extension_ids"],
              let ids = object["extension_ids"] as? [String], !ids.isEmpty,
              ids.allSatisfy(isExtensionId)
        else {
            throw HelperError("caller_refused", "The helper's list of extension ids is missing or malformed; reinstall the helper.")
        }
        return ids
    }

    public static func isExtensionId(_ id: String) -> Bool {
        id.utf8.count == 32 && id.utf8.allSatisfy { $0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "p") }
    }

    /// The extension id of a `chrome-extension://<id>/` origin in the allowlist, or a refusal.
    public static func check(_ argument: String?, allowed: [String]) throws -> String {
        guard let argument else {
            throw HelperError("caller_refused", "The helper is started by Chrome only.")
        }
        let origin = Helper.normalizeOrigin(argument)
        let prefix = "chrome-extension://"
        guard origin.hasPrefix(prefix) else {
            throw HelperError("caller_refused", "The caller is not a Chrome extension.")
        }
        let id = String(origin.dropFirst(prefix.count))
        guard isExtensionId(id), allowed.contains(id) else {
            throw HelperError("caller_refused", "The calling extension is not the WebAgents Agent Browser.")
        }
        return id
    }
}
