/**
 * Keeps the catalog used to describe an agent stable until the caller starts
 * the next turn. Calls deliberately remain live so a server can recover while
 * a prompt is in flight.
 */
export class TurnStableMcpToolSource {
    live;
    catalog;
    pending = false;
    unsubscribe;
    constructor(live) {
        this.live = live;
        this.catalog = live.snapshot();
        this.unsubscribe = live.onCatalogChanged(() => {
            this.pending = true;
        });
    }
    beginTurn() {
        if (this.pending) {
            this.catalog = this.live.snapshot();
            this.pending = false;
        }
    }
    snapshot() {
        return this.catalog;
    }
    callTool(server, tool, args, options) {
        return this.live.callTool(server, tool, args, options);
    }
    onCatalogChanged(listener) {
        return this.live.onCatalogChanged(listener);
    }
    dispose() {
        this.unsubscribe();
    }
}
//# sourceMappingURL=turn-stable-mcp-tool-source.js.map