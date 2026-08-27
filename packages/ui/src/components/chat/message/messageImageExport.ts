const MESSAGE_TEXT_EXPORT_ROOT_SELECTOR = '[data-message-text-export-root]';
const MESSAGE_TEXT_EXPORT_SOURCE_SELECTOR = '[data-message-text-export-source]';

export const collectMessageTextExportSources = (root: Element | null): HTMLElement[] => {
    if (!root) {
        return [];
    }

    return Array.from(root.querySelectorAll<HTMLElement>(MESSAGE_TEXT_EXPORT_SOURCE_SELECTOR)).filter((source) => (
        source.closest(MESSAGE_TEXT_EXPORT_ROOT_SELECTOR) === root
        && Boolean(source.textContent?.trim())
    ));
};
