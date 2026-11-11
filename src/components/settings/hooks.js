// What the tabs of the settings dialog share: the dialog's context (project folder,
// leave guard) and loading from the API.
import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';

/** `{cwd, cluster, guard(action), markDirty(id, dirty)}`, provided by SettingsDialog. */
export const SettingsContext = createContext(null);
export const useSettings = () => useContext(SettingsContext);

/**
 * An editor with unsaved changes reports it here; the dialog then asks before the
 * user leaves it (another tab, scope, file or project, or closing the dialog).
 */
export function useDirty(dirty) {
  const { markDirty } = useSettings();
  const id = useRef({}).current;
  useEffect(() => {
    markDirty(id, dirty);
  }, [dirty]);
  useEffect(() => () => markDirty(id, false), []);
}

/**
 * Loads `load()` whenever `deps` change. `data` stays while a reload runs, so a list does
 * not blink, and goes when the parameters change; `set` puts in a newer copy (the reply of
 * a save) without asking again.
 */
export function useRemote(load, deps) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(deps);
  const lastKey = useRef(key);
  useEffect(() => {
    let live = true;
    // Other parameters mean other data: the old copy goes; a plain reload keeps it meanwhile.
    const moved = lastKey.current !== key;
    lastKey.current = key;
    setState((previous) => ({ loading: true, error: null, data: moved ? null : previous.data }));
    load().then(
      (data) => live && setState({ loading: false, error: null, data }),
      (error) => live && setState({ loading: false, error: error.message, data: null }),
    );
    return () => {
      live = false;
    };
  }, [key, nonce]);
  return {
    ...state,
    reload: () => setNonce((n) => n + 1),
    set: (data) => setState({ loading: false, error: null, data }),
  };
}
