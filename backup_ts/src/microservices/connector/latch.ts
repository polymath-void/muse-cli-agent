export interface RouteState {
  latchedTier: number;
  exhaustedUntil: number;
  isProbing: boolean;
}

export class RouteLatchManager {
  private routes: Map<string, RouteState> = new Map();

  getRouteStatus(cleanModel: string): RouteState {
    return this.routes.get(cleanModel) || {
      latchedTier: 0,
      exhaustedUntil: 0,
      isProbing: false,
    };
  }

  shouldFastPath(cleanModel: string, cascadeLen: number): { isFastPath: boolean; startTierIdx: number } {
    const nowMs = Date.now();
    const state = this.routes.get(cleanModel);
    if (!state) return { isFastPath: false, startTierIdx: 0 };

    if (state.latchedTier > 0) {
      if (nowMs < state.exhaustedUntil) {
        return { isFastPath: true, startTierIdx: Math.min(state.latchedTier, cascadeLen - 1) };
      } else {
        state.isProbing = true;
        return { isFastPath: false, startTierIdx: 0 };
      }
    }
    return { isFastPath: false, startTierIdx: 0 };
  }

  latchFallback(cleanModel: string, tierIdx: number, resetTimeMs: number) {
    this.routes.set(cleanModel, {
      latchedTier: tierIdx,
      exhaustedUntil: resetTimeMs,
      isProbing: false,
    });
  }

  restorePrimary(cleanModel: string) {
    this.routes.delete(cleanModel);
  }
}
