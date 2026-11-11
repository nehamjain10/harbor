// Drag-and-drop target covering the main column. Mount it inside `<main>`; it listens
// on its parent and shows an overlay while files are dragged over it.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ImagePlus } from 'lucide-preact';
import { addFiles, slotFor } from '../../composer.js';
import { store } from '../../state.js';
import { MAX_FILES } from '../../lib/uploads.js';
import './composer.css';

const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');

export function DropZone() {
  const ref = useRef(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const target = ref.current?.parentElement;
    if (!target) return undefined;
    let depth = 0;
    const onEnter = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setActive(true);
    };
    const onOver = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setActive(false);
    };
    const onDrop = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setActive(false);
      const state = store.get();
      if (addFiles(slotFor(state.current?.id), event.dataTransfer.files)) store.set({ focusNonce: state.focusNonce + 1 });
    };
    // A file dropped anywhere else must not navigate the tab away to the file.
    const swallow = (event) => {
      if (hasFiles(event) && !target.contains(event.target)) event.preventDefault();
    };
    target.addEventListener('dragenter', onEnter);
    target.addEventListener('dragover', onOver);
    target.addEventListener('dragleave', onLeave);
    target.addEventListener('drop', onDrop);
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      target.removeEventListener('dragenter', onEnter);
      target.removeEventListener('dragover', onOver);
      target.removeEventListener('dragleave', onLeave);
      target.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  return (
    <div ref={ref} class={`drop-overlay ${active ? 'is-active' : ''}`} aria-hidden={active ? 'false' : 'true'}>
      <div class="drop-frame">
        <span class="drop-icon">
          <ImagePlus size={22} />
        </span>
        <div class="drop-title">Drop to attach</div>
        <div class="drop-note">Images and files · up to 50 MB each · {MAX_FILES} per message</div>
      </div>
    </div>
  );
}
