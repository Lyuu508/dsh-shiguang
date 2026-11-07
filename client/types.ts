import type { Settings } from '../src/config.js';
import type { ShiguangRuntime } from '../src/runtime.js';
import type { MemoryRow, SearchHit } from '../src/memory.js';
export type { Settings, MemoryRow, SearchHit };
export type Status = ReturnType<ShiguangRuntime['status']>;
export type Snapshot = ReturnType<ShiguangRuntime['view']>;
export interface PanelApi { call<T>(action: string, args?: object, signal?: AbortSignal): Promise<T> }
