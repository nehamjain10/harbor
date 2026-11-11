// Full-size image viewer for sent attachments (opened by their thumbnails).
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Download, X } from 'lucide-preact';
import { closeLightbox } from '../../composer.js';
import { useAppState } from '../../state.js';
import { formatBytes } from '../../lib/uploads.js';
import './composer.css';

export function Lightbox() {
  const box = useAppState((s) => s.lightbox || null);

  return box ? <LightboxDialog key={box.url} box={box} /> : null;
}

function LightboxDialog({ box }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.lightbox-close')?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const onClick = (event) => {
    // The image itself does not close; everything around it does.
    if (event.target === ref.current || event.target.classList.contains('lightbox-stage')) closeLightbox();
  };

  return (
    <dialog
      ref={ref}
      class="lightbox"
      aria-label={box.name}
      onClick={onClick}
      onCancel={(event) => {
        event.preventDefault();
        closeLightbox();
      }}
    >
      <div class="lightbox-stage">
        <img src={box.url} alt={box.name} />
      </div>
      <div class="lightbox-bar">
        <span class="lightbox-name" title={box.name}>
          {box.name}
          {box.size ? <span class="lightbox-size">{formatBytes(box.size)}</span> : null}
        </span>
        <a class="btn btn-sm btn-secondary" href={box.url} target="_blank" rel="noopener" download={box.name}>
          <Download size={14} />
          Download
        </a>
        <button type="button" class="icon-btn lightbox-close" onClick={closeLightbox} aria-label="Close">
          <X />
        </button>
      </div>
    </dialog>
  );
}
