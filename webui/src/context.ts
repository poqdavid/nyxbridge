import type { Config, Devices, Status } from './bridge-data';

export interface AppState {
	status: Status;
	statusOk: boolean;
	devices: Devices;
	config: Config;
	log: string;
	prop: Record<string, string>;
	live: boolean;
}

export interface PageContext {
	readonly state: AppState;
	update(patch: Partial<AppState>): void;
	languageChanged(): void;
}
