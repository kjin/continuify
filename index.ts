declare const global: {
  continuify: (fn: Function) => Function,
  getCurrentContext: () => Context
};

interface Continuation {
  linkContext: Context|null;
}

interface Context {
  invocationID: number;
  readyContext: Context|null;
  continuation: Continuation;
}


function polyfillContinuify(exports: any) {
  let activeContexts: Context[] = [];
  let nextInvocationID = 1;

  function getCurrentContext(): Context {
    return activeContexts[activeContexts.length - 1];
  }

  function continuify(fn: Function): Function {
    const continuation: Continuation = {
      linkContext: getCurrentContext()
    };
    // Return the wrapped function.
    return function(this: any, ...args: any[]): any {
      if (activeContexts[0] === firstTick) {
        // This is a hack that assumes that the first continuified function will
        // not be called in the first tick. Ideally we would like all code
        // running in the first tick to be in a function that is continuify'd.
        // But we can't do that, so the best approximiation we can get is manually
        // setting the current context when we enter and exit the first tick,
        // respectively. The statement labelled "beginFirstTickContinuify" is a
        // good approximation of entering the first tick, since we can't run code
        // that is sure to execute right before the first tick ends, we instead
        // consider the closest approximate to exiting the first tick to be the
        // statement labelled "endFirstTickContinuify", which executes after the
        // first tick ends but before user code in any new tick runs.
        // label: endFirstTickContinuify
        activeContexts.pop();
      }
      const readyContext = activeContexts[0].continuation.linkContext;
      const currentContext = {
        invocationID: nextInvocationID++,
        readyContext,
        continuation
      }
      activeContexts.push(currentContext);
      try {
        return fn.call(this, ...args);
      } finally {
        activeContexts.pop();
      }
    }
  }

  let firstTick: Context = {
    invocationID: nextInvocationID++,
    readyContext: null,
    continuation: {
      linkContext: null
    }
  };
  // label: beginFirstTickContinuify
  activeContexts.push(firstTick);

  exports.getCurrentContext = getCurrentContext;
  exports.continuify = continuify;
}

if (!global.continuify) {
  polyfillContinuify(global);
}
