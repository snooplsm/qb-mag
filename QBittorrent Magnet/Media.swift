import Foundation
import SwiftData

// Define a simple Media enum.
enum MyModels {
        enum Media {
            case show(name: String, season: Int, episode: Int?, quality: String?, source: String?, format: String?, hdr: Bool)
            case movie(title: String, year: Int?, quality: String?, source: String?, format: String?, hdr: Bool)    
    }
}

@Model
final class SettingsEntity {
    var host: String
    var date: Date
    
    init(host: String, date:Date = Date()) {
        self.host = host
        self.date = date
    }
}

@Model
final class MediaEntity {
    var date: Date
    var url: URL
    var successful: Date?
    
    init(date: Date, url: URL, successful: Date? = nil) {
            self.date = date
            self.url = url
            self.successful = successful    
    }
}



func parseMedia(from displayName: String) -> MyModels.Media? {
    // If a season indicator exists, assume it's a TV show.
    if displayName.range(of: "(?i)[s]\\d{1,2}", options: .regularExpression) != nil {
        // TV show regex using a greedy lookahead to stop the title capture at the season marker.
        let showPattern = #"(?i)^(?<name>.+?)(?=[\s\.\+_-]+[Ss]\d{1,2})[\s\.\+_-]+[Ss](?<season>\d{1,2})(?:[Ee](?<episode>\d{1,2}))?"#
        if let regex = try? NSRegularExpression(pattern: showPattern),
           let match = regex.firstMatch(in: displayName, options: [], range: NSRange(displayName.startIndex..., in: displayName)) {
            
            guard let nameRange = Range(match.range(withName: "name"), in: displayName),
                  let seasonRange = Range(match.range(withName: "season"), in: displayName) else {
                return nil
            }
            
            let name = String(displayName[nameRange])
                .replacingOccurrences(of: "[.\\+_-]+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            let season = Int(String(displayName[seasonRange])) ?? 0
            
            var episode: Int? = nil
            if let episodeRange = Range(match.range(withName: "episode"), in: displayName),
               match.range(withName: "episode").location != NSNotFound {
                episode = Int(String(displayName[episodeRange]))
            }
            
            let extra = extractExtraInfo(from: displayName)
            return MyModels.Media.show(name: name, season: season, episode: episode, quality: extra.quality, source: extra.source, format: extra.format, hdr: extra.hdr)
        }
    } else {
        // Otherwise, assume it's a movie.
        let moviePattern = #"(?i)^(?<title>.+?)[\s\.\+_-]+\(?\s*(?<year>\d{4})\s*\)?"#
        if let regex = try? NSRegularExpression(pattern: moviePattern),
           let match = regex.firstMatch(in: displayName, options: [], range: NSRange(displayName.startIndex..., in: displayName)) {
            
            guard let titleRange = Range(match.range(withName: "title"), in: displayName) else { return nil }
            let title = String(displayName[titleRange])
                .replacingOccurrences(of: "[.\\+_-]+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            
            var year: Int? = nil
            if let yearRange = Range(match.range(withName: "year"), in: displayName),
               match.range(withName: "year").location != NSNotFound {
                let rawYear = String(displayName[yearRange]).replacingOccurrences(of: ",", with: "")
                year = Int(rawYear)
            }
            
            let extra = extractExtraInfo(from: displayName)
            return MyModels.Media.movie(title: title, year: year, quality: extra.quality, source: extra.source, format: extra.format, hdr: extra.hdr)
        }
    }
    return nil
}

func extractExtraInfo(from displayName: String) -> (quality: String?, source: String?, format: String?, hdr: Bool) {
    // Extract quality, e.g., "1080p" or "2160p"
    let qualityRegex = try? NSRegularExpression(pattern: #"(?i)\b(\d{3,4}p)\b"#)
    var quality: String? = nil
    if let match = qualityRegex?.firstMatch(in: displayName, options: [], range: NSRange(displayName.startIndex..., in: displayName)),
       let range = Range(match.range(at: 1), in: displayName) {
        quality = String(displayName[range])
    }
    
    // Extract source: "WEB-DL", "WEB", or "BLURAY"
    let sourceRegex = try? NSRegularExpression(pattern: #"(?i)\b(WEB[-\s]?DL|WEB|BLURAY)\b"#)
    var source: String? = nil
    if let match = sourceRegex?.firstMatch(in: displayName, options: [], range: NSRange(displayName.startIndex..., in: displayName)),
       let range = Range(match.range(at: 1), in: displayName) {
        source = String(displayName[range])
    }
    
    // Extract format: e.g., "x265", "H265", "xvid", "h264", or "H264"
    let formatRegex = try? NSRegularExpression(pattern: #"(?i)\b(x265|H\s?265|xvid|h264|H\s?264)\b"#)
    var format: String? = nil
    if let match = formatRegex?.firstMatch(in: displayName, options: [], range: NSRange(displayName.startIndex..., in: displayName)),
       let range = Range(match.range(at: 1), in: displayName) {
        format = String(displayName[range])
    }
    
    // Check if HDR is present.
    let hdrRegex = try? NSRegularExpression(pattern: #"(?i)\bHDR\b"#)
    var hdr = false
    if let _ = hdrRegex?.firstMatch(in: displayName, options: [], range: NSRange(displayName.startIndex..., in: displayName)) {
        hdr = true
    }
    
    return (quality, source, format, hdr)
}

// Extract the "dn" parameter from a magnet URL and parse it.
func parseMagnetDisplayName(from magnetURL: URL) async -> MyModels.Media? {
    guard
        let components = URLComponents(url: magnetURL, resolvingAgainstBaseURL: false),
          let dnItem = components.queryItems?.first(where: { $0.name.lowercased() == "dn" }),
          let displayName = dnItem.value else {
        return nil
    }
    
    return parseMedia(from: displayName)
}

func uploadTorrent(qbUrl: String, savePath: String, magnetUrl: String) async -> Bool {
    // Simulate login (in your Kotlin code, login is commented out and "Ok." is assumed).
    let loginResponse = "Ok."
    
    guard loginResponse == "Ok." else {
        print("Login failed: \(loginResponse)")
        return false
    }
    
    // Construct the URL for adding torrents.
    guard let url = URL(string: "\(qbUrl)/api/v2/torrents/add") else {
        print("Invalid QB URL")
        return false
    }
    
    // Build the form data as a URL-encoded string.
    let parameters: [String: String] = [
        "urls": magnetUrl,
        "savepath": savePath
    ]
    let formBody = parameters
        .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")" }
        .joined(separator: "&")
    
    // Create a URLRequest configured for a POST with URL-encoded form data.
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = formBody.data(using: .utf8)
    
    do {
        // Perform the request asynchronously.
        let (data, response) = try await URLSession.shared.data(for: request)
        if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
            let responseText = String(data: data, encoding: .utf8) ?? ""
            print("Add torrent response: \(responseText)")
            return true
        } else {
            print("Add torrent failed, response: \(response)")
            return false
        }
    } catch {
        print("Error during torrent upload: \(error)")
        return false
    }
}
