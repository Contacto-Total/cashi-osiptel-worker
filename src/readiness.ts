let _lastOkAt: number | null = null;

export function markOk(): void { _lastOkAt = Date.now(); }
export function getLastOkAt(): number | null { return _lastOkAt; }
