// WebFetch (page + prompt + summarized result) and WebSearch (query + links).
import { ExternalLink, Globe, Search } from 'lucide-preact';
import { parseWebSearch } from '../../lib/toolOutput.js';
import { Markdown } from '../Markdown.jsx';
import { Chip, Clamp, Note, OutputBlock } from './shared.jsx';

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Only http(s) URLs become links: anything else the model or a page supplied
// (javascript:, data:, file:) is shown as plain text.
function isWebUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function ExternalUrl({ url }) {
  if (!isWebUrl(url)) {
    return (
      <span class="tool-link is-plain mono" title={url}>
        <Globe size={13} />
        <span>{url}</span>
      </span>
    );
  }
  return (
    <a class="tool-link mono" href={url} target="_blank" rel="noopener noreferrer" title={url}>
      <Globe size={13} />
      <span>{url}</span>
      <ExternalLink size={12} class="tool-link-out" />
    </a>
  );
}

export function WebFetchDetail({ message, output }) {
  const input = message.input || {};
  return (
    <>
      {input.url && <ExternalUrl url={input.url} />}
      {input.prompt && <p class="tool-desc">{input.prompt}</p>}
      {message.state === 'error' ? (
        <OutputBlock text={output} error />
      ) : output ? (
        <Clamp maxHeight={280} class="tool-markdown">
          <Markdown text={output} class="markdown-sm" />
        </Clamp>
      ) : (
        <Note>{message.state === 'running' ? 'Fetching…' : 'No content'}</Note>
      )}
    </>
  );
}

export function WebSearchDetail({ message, output }) {
  const input = message.input || {};
  const { links, text } = parseWebSearch(output);
  return (
    <>
      <div class="chip-row">
        <Chip tone="accent">
          <Search size={12} />
          {input.query}
        </Chip>
        {(input.allowed_domains || []).map((d) => (
          <Chip key={'a' + d} mono>
            only {d}
          </Chip>
        ))}
        {(input.blocked_domains || []).map((d) => (
          <Chip key={'b' + d} mono>
            not {d}
          </Chip>
        ))}
      </div>
      {message.state === 'error' && <OutputBlock text={output} error />}
      {links.length > 0 && (
        <ul class="link-list">
          {links.map((link, i) => (
            <li key={link.url + i}>
              {isWebUrl(link.url) ? (
                <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
                  <span class="link-title">{link.title}</span>
                  <span class="link-host mono">{hostOf(link.url)}</span>
                </a>
              ) : (
                <span class="link-plain" title={link.url}>
                  <span class="link-title">{link.title}</span>
                  <span class="link-host mono">{link.url}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {text && message.state !== 'error' && (
        <Clamp maxHeight={200} class="tool-markdown">
          <Markdown text={text} class="markdown-sm" />
        </Clamp>
      )}
      {!links.length && !text && message.state !== 'error' && <Note>{message.state === 'running' ? 'Searching…' : 'No results'}</Note>}
    </>
  );
}
