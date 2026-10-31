import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// Polyfill WebCrypto...
if (!globalThis.crypto) {
	globalThis.crypto = webcrypto as any;
} else if (!globalThis.crypto.subtle) {
	globalThis.crypto.subtle = webcrypto.subtle as any;
	globalThis.crypto.getRandomValues = webcrypto.getRandomValues.bind(webcrypto) as any;
}

// Add these dummy exports to satisfy Vite's resolver and `instanceof` checks
export class App {}
export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export class WorkspaceLeaf {}
export class Notice {
	constructor(public message?: string) {}
}
export class Setting {
	constructor(public containerEl?: any) {}
	setName() { return this; }
	setDesc() { return this; }
	addText() { return this; }
	addButton() { return this; }
	addToggle() { return this; }
}
export class Modal {
	public contentEl: any = { empty() {}, createEl() { return {}; }, createDiv() { return {}; } };
	constructor(public app: App) {}
	open() {}
	close() {}
}
export class ItemView {
	public contentEl: any = { empty() {}, createEl() { return {}; }, createDiv() { return {}; } };
	constructor(public leaf: WorkspaceLeaf) {}
	registerInterval(id: number) { return id; }
}
export class PluginSettingTab {
	public containerEl: any = { empty() {} };
	constructor(public app: App, public plugin: any) {}
	update() {}
}
export class Plugin {
	public app: any;
	public manifest: any;
	constructor(app: any, manifest?: any) {
		this.app = app;
		this.manifest = manifest;
	}
	async loadData(): Promise<any> { return {}; }
	async saveData(_data: any): Promise<void> {}
	registerView(_type: string, _creator: any) {}
	addStatusBarItem() {
		return {
			addClass() {},
			setText() {},
			onClickEvent() {}
		};
	}
	addRibbonIcon(_icon: string, _title: string, _cb: () => any) { return {}; }
	addSettingTab(_tab: any) {}
	registerEvent(_ref: any) {}
}
export const setIcon = (_el: any, _icon: string) => {};

export const requestUrl = async (_options: any) => {
	return { status: 200, json: {}, text: '' };
};
