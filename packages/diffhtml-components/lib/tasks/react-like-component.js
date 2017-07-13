import { createTree, Internals } from 'diffhtml';
import getContext from '../util/get-context';
import {
  ChildParentCache,
  ComponentTreeCache,
  InstanceCache,
} from '../util/caches';

const { NodeCache } = Internals;
const { keys, assign } = Object;

function triggerRef(ref, node) {
  if (typeof ref === 'function') {
    ref(node);
  }
  else if (typeof ref === 'string') {
    this[ref](node);
  }
}

function searchForRefs(newTree) {
  if (newTree.attributes.ref) {
    triggerRef(newTree.attributes.ref, NodeCache.get(newTree));
  }

  newTree.childNodes.forEach(searchForRefs);
}

function componentDidMount(newTree) {
  const instance = InstanceCache.get(newTree);

  if (instance) {
    instance.componentDidMount();
  }

  searchForRefs(newTree);

  newTree.childNodes.forEach(componentDidMount);

  if (!instance) {
    return;
  }

  const { ref } = instance.props;
  triggerRef(ref, instance);
}

function componentDidUnmount(oldTree) {
  const oldChild = ChildParentCache.get(oldTree);
  const instance = InstanceCache.get(oldChild) || InstanceCache.get(oldTree);

  if (instance) {
    instance.componentWillUnmount();
    instance.componentDidUnmount();
  }

  searchForRefs(oldTree);

  oldTree.childNodes.forEach(componentDidUnmount);

  if (!instance) {
    return;
  }

  const { ref } = instance.props;

  triggerRef(ref, null);
}

export default function reactLikeComponentTask(transaction) {
  transaction.onceEnded(() => {
    if (transaction.aborted) {
      return;
    }

    const { patches } = transaction;

    if (patches.TREE_OPS && patches.TREE_OPS.length) {
      patches.TREE_OPS.forEach(({
        INSERT_BEFORE,
        REPLACE_CHILD,
        REMOVE_CHILD,
      }) => {
        if (INSERT_BEFORE) {
          for (let i = 0; i < INSERT_BEFORE.length; i += 3) {
            const newTree = INSERT_BEFORE[i + 1];
            componentDidMount(newTree);
          }
        }

        if (REPLACE_CHILD) {
          for (let i = 0; i < REPLACE_CHILD.length; i += 2) {
            const newTree = REPLACE_CHILD[i];
            const oldTree = REPLACE_CHILD[i + 1];

            if (InstanceCache.has(oldTree)) {
              ComponentTreeCache.delete(InstanceCache.get(oldTree));
              InstanceCache.delete(oldTree);
              ChildParentCache.delete(oldTree);
            }

            InstanceCache.delete(oldTree);
            componentDidMount(newTree);
          }
        }

        if (REMOVE_CHILD) {
          for (let i = 0; i < REMOVE_CHILD.length; i += 1) {
            const oldTree = REMOVE_CHILD[i];
            const oldInstance = InstanceCache.has(oldTree);

            if (oldInstance) {
              ComponentTreeCache.delete(oldInstance);
              InstanceCache.delete(oldTree);
              ChildParentCache.delete(oldTree);
            }

            componentDidUnmount(oldTree);
          }
        }
      });
    }
  });
}

function renderComponent({ oldTree, newTree, oldChild, newChild }) {
  let oldInstanceCache = null;

  if (oldChild && oldChild.nodeName) {
    oldInstanceCache = InstanceCache.get(ChildParentCache.get(oldChild));
  }

  const newCtor = newChild.rawNodeName;
  const { childNodes } = newChild;
  const children = (childNodes.length === 1 ? childNodes[0] : childNodes) || [];
  const props = assign({}, newChild.attributes, { children });
  const canNew = newCtor.prototype && newCtor.prototype.render;

  // If the component has already been initialized, we can reuse it.
  const oldInstance = oldInstanceCache instanceof newCtor && oldInstanceCache;
  const context = assign(getContext(oldTree), getContext(newTree));
  const newInstance = !oldInstance && canNew && new newCtor(props, context);
  const instance = oldInstance || newInstance;

  let renderTree = null;

  if (instance) {
    const { defaultProps = {} } = instance.constructor;

    keys(defaultProps).forEach(prop => {
      if (prop in props && props[prop] !== undefined) {
        return;
      }

      props[prop] = defaultProps[prop];
    });
  }

  if (oldInstance) {
    oldInstance.componentWillReceiveProps(props);
    oldInstance.props = props;
    InstanceCache.delete(ComponentTreeCache.get(oldInstance));

    if (oldInstance.shouldComponentUpdate()) {
      renderTree = oldInstance.render(props, oldInstance.state);
      oldInstance.componentDidUpdate(props, oldInstance.state || {});
    }

    ComponentTreeCache.set(oldInstance, renderTree);
    InstanceCache.set(renderTree, oldInstance);
    oldTree.childNodes.splice(oldTree.childNodes.indexOf(newTree), 1, renderTree);

    return renderTree;
  }
  else if (instance && instance.render) {
    instance.props = props;
    renderTree = createTree(instance.render(props, instance.state));
  }
  else {
    renderTree = createTree(newCtor(props));
  }

  // Nothing was rendered so continue.
  if (!renderTree) {
    return null;
  }

  // Replace the rendered value into the new tree, if rendering a fragment
  // this will inject the contents into the parent.
  if (typeof renderTree.rawNodeName === 'string' && renderTree.nodeType === 11) {
    newTree.childNodes = [...renderTree.childNodes];

    if (instance) {
      ComponentTreeCache.set(instance, oldTree);
      InstanceCache.set(oldTree, instance);
    }
  }
  // If the rendered value is a single element use it as the root for
  // diffing.
  else if (instance) {
    ComponentTreeCache.set(instance, renderTree);
    InstanceCache.set(newTree, instance);
  }

  oldTree.childNodes.splice(oldTree.childNodes.indexOf(newTree), 1, renderTree);

  return renderTree;
}

reactLikeComponentTask.syncTreeHook = (oldTree, newTree, keys, parentTree) => {
  // FIXME Detect for external VNode/VTree like instances. Externalize this
  // logic, does not belong here, used for now to fix Preact compatibility.
  if (newTree && newTree.children && !newTree.childNodes) {
    newTree = createTree(newTree.nodeName, newTree.attributes, newTree.children);
  }

  // Top level component to process.
  if (newTree && typeof newTree.rawNodeName === 'function') {
    ChildParentCache.set(newTree, parentTree);

    const upgraded = renderComponent({
      oldTree: parentTree,
      newTree,
      oldChild: oldTree,
      newChild: newTree,
    });

    if (!ChildParentCache.has(newTree)) {
      ChildParentCache.set(upgraded, parentTree);
    }
    else {
      ChildParentCache.set(upgraded, newTree);
    }

    return upgraded;
  }

  if (parentTree) {
    ChildParentCache.set(newTree, parentTree);
  }

  return newTree;
};
