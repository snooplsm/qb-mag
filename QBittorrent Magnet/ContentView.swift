//
//  ContentView.swift
//  QBittorrent Magnet
//
//  Created by Ryan Gravener on 3/31/25.
//

import SwiftData
import SwiftUI

struct ContentView: View {
    @Binding var magnetLink: URL?
    @State private var media: MyModels.Media? = nil
    @Environment(\.modelContext) private var context
    // Fetch all Person objects using a fetch descriptor.
    //    @Query(sort:\.date) private var medias: [MediaEntity]
    @Query(sort: \SettingsEntity.date, order: .reverse)
    private var settingsEntities: [SettingsEntity]
    
    var latestSettings: SettingsEntity {
        if let settings = settingsEntities.first {
                return settings
            } else {
                let newSettings = SettingsEntity(host: "http://192.168.50.23:8080", date: Date())
                context.insert(newSettings)
                try? context.save()
                return newSettings
            }
    }
    
    var hostBinding: Binding<String> {
            Binding(
                get: { latestSettings.host },
                set: { newHost in
                    latestSettings.host = newHost
                    try? context.save()
                }
            )
        }
    
    var body: some View {
        VStack {
            TextField("QBittorrent Host", text: hostBinding)
                .textFieldStyle(.roundedBorder)
                .padding()
            
            if let url = media {
                MediaView(media: url)
            } else {
                Text("Click on a magnet link to send it to Qbittorrent, change the host")
            }
        }
        .padding()
        .task {
            updateMedia()
        }
        .onChange(of: magnetLink) {
            updateMedia()
        }
    }
    
    private func updateMedia() {
        Task {
            guard let url = magnetLink else { return }
            if let parsedMedia = await parseMagnetDisplayName(from: url) {
                media = parsedMedia
                
                let folder: String = {
                    switch parsedMedia {
                    case .show(let name, let season, _, _, _, _, _):
                        return "/tv/\(name)/Season \(season)"
                    case .movie(let title, let year, _, _, _, _):
                        let yearString = year.map(String.init) ?? "unknown"
                        return "/movies/\(title) \(yearString)".trimmingCharacters(in: .whitespaces)
                    }
                }()
                // Explicitly annotate the type of success.
                let newEntity = MediaEntity(date: Date(), url: url)
                context.insert(newEntity)
                try? context.save()
                let success: Bool = await uploadTorrent(qbUrl: latestSettings.host, savePath: folder, magnetUrl: url.absoluteString)
                print("Upload torrent result: \(success)")
                if(success) {
                    newEntity.successful = Date()
                    try? context.save()
                }
            }
        }
    }
    
}

struct MediaView: View {
    var media: MyModels.Media

    var body: some View {
        VStack(spacing: 8) {
            switch media {
            case .show(let name, let season, let episode, let quality, let source, let format, let hdr):
                Text("Show: \(name)")
                    .font(.title)
                Text("Season: \(season)")
                    .font(.headline)
                if let episode = episode {
                    Text("Episode: \(episode)")
                        .font(.subheadline)
                }
                Text("Quality: \(quality ?? "N/A")")
                Text("Source: \(source ?? "N/A")")
                Text("Format: \(format ?? "N/A")")
                Text("HDR: \(hdr ? "Yes" : "No")")
            case .movie(let title, let year, let quality, let source, let format, let hdr):
                Text("Movie: \(title)")
                    .font(.title)
                if let year = year {
                    Text("Year: \(year)")
                        .font(.subheadline)
                }
                Text("Quality: \(quality ?? "N/A")")
                Text("Source: \(source ?? "N/A")")
                Text("Format: \(format ?? "N/A")")
                Text("HDR: \(hdr ? "Yes" : "No")")
            }
        }
        .padding()
    }
}

//struct MediaView_Previews: PreviewProvider {
//    static var previews: some View {
//        Group {
//            MediaView(media: .show(name: "The Show", season: 2, episode: 5, quality: "1080p", source: "WEB-DL", format: "x265", hdr: false))
//            MediaView(media: .movie(title: "Example Movie", year: 1995,quality: "1080p", source: "WEB-DL", format: "x265", hdr: false))
//        }
//    }
//}

//#Preview {
//    ContentView(
//        magnetLink: .constant(
//            URL(
//                string:
//                    "magnet:?xt=urn:btih:87DED46D83C792A787D04AAB5C129526C445DBAA&dn=Last.Breath.2025.1080p.WEB-DL.AAC5.1.x265-NeoNoir&tr=http%3A%2F%2Fp4p.arenabg.com%3A1337%2Fannounce&tr=udp%3A%2F%2F47.ip-51-68-199.eu%3A6969%2Fannounce&tr=udp%3A%2F%2F9.rarbg.me%3A2780%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2710%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2730%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2920%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Fopentracker.i2p.rocks%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.cyberia.is%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.dler.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.internetwarriors.net%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.pirateparty.gr%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.tiny-vps.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce"
//            )
//        ))
//}
