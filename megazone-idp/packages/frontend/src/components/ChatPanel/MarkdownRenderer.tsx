import { Children, isValidElement, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { Loader2 } from 'lucide-react';
import type { Components } from 'react-markdown';
import MermaidBlock from './MermaidBlock';

function decodeHtmlEntities(text: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

// Sentinel src injected by prepareMarkdown for an image link that is still
// streaming (its URL hasn't fully arrived yet).
const IMG_LOADING_SENTINEL = 'idp-img-loading';

function LoadingChip() {
  return (
    <span className="my-2 inline-flex items-center gap-2 rounded-lg border border-black/10 bg-black/5 px-3 py-2 text-sm text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin" />
      이미지 불러오는 중…
    </span>
  );
}

/** Markdown image: shows a spinner while the URL is still streaming (sentinel)
 *  and while the real image is downloading, then reveals the image. */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  if (!src || src === IMG_LOADING_SENTINEL) return <LoadingChip />;
  if (errored) {
    return (
      <span className="my-2 inline-block text-sm text-slate-400">
        이미지를 불러올 수 없습니다.
      </span>
    );
  }
  return (
    <>
      {!loaded && <LoadingChip />}
      <img
        src={src}
        alt={alt ?? ''}
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        className={loaded ? 'my-2 max-w-full rounded-lg' : 'hidden'}
      />
    </>
  );
}

const components: Components = {
  img: ({ src, alt }) => (
    <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} />
  ),
  // Override <pre> instead of <code> to avoid invalid <div> inside <pre> nesting.
  // Fenced code blocks render as <pre><code class="language-xxx">...</code></pre>.
  pre({ children, ...props }) {
    const child = Children.toArray(children)[0];
    if (isValidElement(child)) {
      const childProps = child.props as {
        className?: string;
        children?: React.ReactNode;
      };
      if (/language-mermaid/.test(childProps.className || '')) {
        const raw = String(childProps.children).replace(/\n$/, '');
        return <MermaidBlock code={decodeHtmlEntities(raw)} />;
      }
    }
    return <pre {...props}>{children}</pre>;
  },
};

interface MarkdownRendererProps {
  children: string;
}

export default function MarkdownRenderer({ children }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
      rehypePlugins={[rehypeRaw]}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
