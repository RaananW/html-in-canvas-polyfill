export const HOST_ATTR = 'data-hic-host';

export function composedParent(node: Node): Node | null {
  return node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
}

export function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && (node as Node).nodeType === 1;
}

export function invalidState(message: string): DOMException {
  return new DOMException(message, 'InvalidStateError');
}

/** Sorts elements into reverse tree order (descendants before ancestors). */
export function reverseTreeOrder(elements: Iterable<Element>): Element[] {
  return Array.from(elements).sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return 1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return -1;
    return 0;
  });
}
