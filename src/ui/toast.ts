let host: HTMLElement | null = null;
let timer = 0;

/** 画面下部に短いメッセージを出す。 */
export function toast(parent: HTMLElement, message: string, ms = 1800): void {
  if (!host || !host.isConnected) {
    host = document.createElement('div');
    host.className = 'toast';
    host.setAttribute('role', 'status');
    parent.appendChild(host);
  }
  host.textContent = message;
  host.classList.add('show');
  window.clearTimeout(timer);
  timer = window.setTimeout(() => host?.classList.remove('show'), ms);
}
