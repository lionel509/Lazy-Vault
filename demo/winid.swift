// Prints the window number of the first on-screen, normal-layer window owned by a pid.
// Usage: swift demo/winid.swift <pid>   (exit 1 when none is found)
import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1, let pid = Int(CommandLine.arguments[1]) else {
    FileHandle.standardError.write("usage: winid <pid>\n".data(using: .utf8)!)
    exit(2)
}

guard let list = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
    exit(1)
}

for w in list {
    guard let owner = w[kCGWindowOwnerPID as String] as? Int, owner == pid,
          let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
          let number = w[kCGWindowNumber as String] as? Int else { continue }
    print(number)
    exit(0)
}
exit(1)
