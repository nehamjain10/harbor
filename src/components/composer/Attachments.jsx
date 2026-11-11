// Attachment chips: the composer's tray (uploading / done / failed, remove, retry)
// and the read-only list shown above a sent user message.
import { EyeOff, File, FileArchive, FileCode, FileSpreadsheet, FileText, RotateCw, X } from 'lucide-preact';
import { openLightbox, removeAttachment, retryAttachment } from '../../composer.js';
import { formatBytes } from '../../lib/uploads.js';
import './composer.css';

const CODE = /\.(m?[jt]sx?|c?js|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|sql|ya?ml|toml|json|html?|css|scss|vue|svelte|lua|r|ipynb)$/i;
const SHEET = /\.(csv|tsv|xlsx?|parquet)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;
const TEXT = /\.(md|txt|log|rst|pdf|docx?|rtf)$/i;

export function FileIcon({ name, size = 16 }) {
  const Icon = CODE.test(name) ? FileCode : SHEET.test(name) ? FileSpreadsheet : ARCHIVE.test(name) ? FileArchive : TEXT.test(name) ? FileText : File;
  return <Icon size={size} />;
}

function extension(name) {
  const match = String(name || '').match(/\.([a-z0-9]{1,6})$/i);
  return match ? match[1].toUpperCase() : '';
}

function ProgressRing({ value }) {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const indeterminate = !(value > 0);
  return (
    <svg class={`attach-progress ${indeterminate ? 'spin' : ''}`} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={radius} class="attach-progress-track" />
      <circle
        cx="12"
        cy="12"
        r={radius}
        class="attach-progress-value"
        stroke-dasharray={`${circumference * (indeterminate ? 0.28 : Math.max(0.04, value))} ${circumference}`}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}

function statusText(item) {
  if (item.status === 'uploading') return item.progress > 0 ? `Uploading ${Math.round(item.progress * 100)}%` : 'Uploading…';
  if (item.status === 'error') return item.error || 'Upload failed';
  return [extension(item.name), formatBytes(item.size)].filter(Boolean).join(' · ');
}

function AttachmentChip({ slot, item, visionOff }) {
  const label = `${item.name}${item.status === 'error' ? ' — ' + (item.error || 'upload failed') : ''}`;
  const retry = (
    <button type="button" class="attach-retry" onClick={() => retryAttachment(slot, item.key)} aria-label={`Retry uploading ${item.name}`} title={`${item.error || 'Upload failed'} · Retry`}>
      <RotateCw size={item.image ? 15 : 13} />
    </button>
  );
  return (
    <div class={`attach-chip ${item.image ? 'is-image' : 'is-file'} is-${item.status}`} role="listitem" title={label}>
      {item.image ? (
        <span class="attach-thumb">
          <img src={item.previewUrl || item.attachment?.url} alt="" draggable={false} />
          {item.status === 'uploading' && (
            <span class="attach-overlay">
              <ProgressRing value={item.progress} />
            </span>
          )}
          {item.status === 'error' && <span class="attach-overlay is-error">{retry}</span>}
          {visionOff && item.status === 'done' && (
            <span class="attach-badge" title="Sent as a file path — this model can't see images">
              <EyeOff size={11} />
            </span>
          )}
        </span>
      ) : (
        <>
          <span class="attach-icon">{item.status === 'uploading' ? <ProgressRing value={item.progress} /> : <FileIcon name={item.name} />}</span>
          <span class="attach-text">
            <span class="attach-name">{item.name}</span>
            <span class="attach-meta">{statusText(item)}</span>
          </span>
          {item.status === 'error' && retry}
          {item.status === 'uploading' && <span class="attach-bar" style={{ '--progress': item.progress || 0 }} />}
        </>
      )}
      <button type="button" class="attach-remove" onClick={() => removeAttachment(slot, item.key)} aria-label={`Remove ${item.name}`} title="Remove">
        <X size={12} strokeWidth={2.25} />
      </button>
    </div>
  );
}

export function AttachmentTray({ slot, items, visionOff }) {
  if (!items.length) return null;
  const imageNote = visionOff && items.some((item) => item.image);
  return (
    <div class="attach-tray">
      <div class="attach-list" role="list" aria-label="Attachments">
        {items.map((item) => (
          <AttachmentChip key={item.key} slot={slot} item={item} visionOff={visionOff} />
        ))}
      </div>
      {imageNote && (
        <div class="attach-note">
          <EyeOff size={13} />
          Sent as a file path — this model can't see images
        </div>
      )}
    </div>
  );
}

// Attachments of a sent user message: image thumbnails open the lightbox, files
// open (or download) in a new tab.
export function MessageAttachments({ attachments }) {
  if (!attachments?.length) return null;
  return (
    <div class="msg-attachments">
      {attachments.map((a) =>
        a.image ? (
          <button type="button" key={a.id} class="sent-thumb" onClick={() => openLightbox(a)} aria-label={`Open ${a.name}`} title={a.name}>
            <img src={a.url} alt={a.name} loading="lazy" />
          </button>
        ) : (
          <a key={a.id} class="sent-file" href={a.url} target="_blank" rel="noopener" download={a.name} title={`Open ${a.name}`}>
            <span class="attach-icon">
              <FileIcon name={a.name} size={15} />
            </span>
            <span class="attach-text">
              <span class="attach-name">{a.name}</span>
              <span class="attach-meta">{[extension(a.name), formatBytes(a.size)].filter(Boolean).join(' · ')}</span>
            </span>
          </a>
        ),
      )}
    </div>
  );
}
