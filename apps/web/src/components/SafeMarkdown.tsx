// Agent reply rendering (A-01 §9.4, D-25): react-markdown WITHOUT any raw-HTML plugin, images dropped,
// links rendered as plain text (never an <a>). `javascript:` and similar URLs are inert text as a result.
import ReactMarkdown, { type Components } from 'react-markdown';

const components: Components = {
  a({ children, href }) {
    const label = textOf(children);
    // Show the target as plain text so a disguised link stays visible; never clickable.
    const showHref = typeof href === 'string' && href !== '' && href !== label;
    return (
      <span className="plain-link">
        {children}
        {showHref ? ` (${href})` : null}
      </span>
    );
  },
  img() {
    return null;
  },
};

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

export function SafeMarkdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
