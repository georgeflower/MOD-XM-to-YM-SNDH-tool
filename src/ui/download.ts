export function download(name: string, data: Uint8Array | string, type = 'application/octet-stream') {
  const part = typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>);
  const url = URL.createObjectURL(new Blob([part], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
