import WidgetKit
import SwiftUI

// Provider used by widgets that don't expose user configuration (Heatmap,
// Limits, Clawd). Same on-disk snapshot, no AppIntent.

struct StaticEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct StaticSnapshotProvider: TimelineProvider {
    typealias Entry = StaticEntry

    func placeholder(in context: Context) -> StaticEntry {
        StaticEntry(date: Date(), snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (StaticEntry) -> Void) {
        let snap = WidgetSnapshotStore.read() ?? .placeholder
        completion(StaticEntry(date: Date(), snapshot: snap))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StaticEntry>) -> Void) {
        let snap = WidgetSnapshotStore.read() ?? .empty
        let entry = StaticEntry(date: Date(), snapshot: snap)
        let next = Date().addingTimeInterval(15 * 60)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}
