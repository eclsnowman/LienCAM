export interface TransferEnvelope<T> {
  readonly __meshComlinkTransfer: true;
  readonly value: T;
  readonly transferables: Transferable[];
}

export const Comlink = {
  transfer<T>(value: T, transferables: Transferable[]): TransferEnvelope<T> {
    return { __meshComlinkTransfer: true, value, transferables };
  },
};

export function isTransferEnvelope(value: unknown): value is TransferEnvelope<unknown> {
  return typeof value === 'object' && value !== null && '__meshComlinkTransfer' in value;
}
