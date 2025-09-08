//
//  Item.swift
//  QBittorrent Magnet
//
//  Created by Ryan Gravener on 3/31/25.
//

import Foundation
import SwiftData

@Model
final class Item {
    var timestamp: Date
    
    init(timestamp: Date) {
        self.timestamp = timestamp
    }
}
