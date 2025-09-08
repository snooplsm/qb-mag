import SwiftUI
import SwiftData

@main
struct QBittorrent_MagnetApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    
    @State private var magnetLink: URL?

        var body: some Scene {
            Window("Magnet App", id: "MainWindow") {
                ContentView(magnetLink: $magnetLink)
                    .onOpenURL { url in
                        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                           let dnItem = components.queryItems?.first(where: { $0.name.lowercased() == "dn" }),
                           let displayName = dnItem.value {
                            print("Received Magnet: \(displayName)")
                            magnetLink = url
                            // Here, you can handle the magnet URL as needed.
                        }
                    }
                    .modelContainer(for: [MediaEntity.self, SettingsEntity.self])
            }
        }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // If there are no visible windows, show the first one.
        if !flag, let window = NSApplication.shared.windows.first {
            window.makeKeyAndOrderFront(self)
        }
        // Return true so that the app reuses the existing window.
        return true
    }
}
