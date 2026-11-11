// memo() for Preact without pulling in preact/compat (whose option hooks would change
// event and attribute handling app-wide): skips re-rendering while props are shallowly
// equal.
import { Component } from 'preact';
import { shallowEqual } from './store.js';

export function memo(render) {
  class Memo extends Component {
    shouldComponentUpdate(nextProps) {
      return !shallowEqual(this.props, nextProps);
    }

    render(props) {
      return render(props);
    }
  }
  Memo.displayName = `Memo(${render.name || 'Component'})`;
  return Memo;
}
