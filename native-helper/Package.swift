// swift-tools-version:6.0
// The WebAgents native helper (T17, D-201, D-204): one binary Chrome starts through native
// messaging, with three operations and nothing else.
import PackageDescription

let package = Package(
    name: "webagents-helper",
    platforms: [.macOS(.v12)],
    targets: [
        .target(name: "HelperCore"),
        .executableTarget(name: "webagents-helper", dependencies: ["HelperCore"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
    ],
    swiftLanguageModes: [.v5]
)
