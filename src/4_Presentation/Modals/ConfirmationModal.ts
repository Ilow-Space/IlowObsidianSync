import { Modal, App, Setting } from 'obsidian';

export class ConfirmationModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private title: string,
		private message: string,
		private confirmButtonText: string,
		private onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: this.title });
		contentEl.createEl('p', { text: this.message });

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Cancel')
					.onClick(() => {
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(this.confirmButtonText)
					.setDestructive()
					.onClick(() => {
						this.confirmed = true;
						this.close();
						void this.onConfirm();
					})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
