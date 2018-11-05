Despite Promises being implemented natively within the VM, I believe it is possible to add calls to `continuify` within the implementation of `Promise` such that no extra machinery is needed within `continuify` to deal specifically with Promises.

This relies on the pre-requisite assumptions:
1. Although a single function typically won't be `continuify`'d multiple times, it is possible for us to be running in multiple `continuify`'d functions at the same time. See [`pooled-read-file`](./pooled-read-file.js) for an example of this.
1. There is a well-defined order in which we invoked each one of the `continuify`'d functions. It is the order in which they are placed on the stack.
1. The `linkContext` of the first such continuation is the `readyContext` of subsequent continuations.
    1. It follows that only the first entered continuation is _guaranteed_ to have the same `linkContext` and `readyContext`. Subsequent continuations _may_ have this property, but it's not guaranteed (each instance where the two are not the same is an instance of userspace queueing).

Whether the reader agrees with the above assertions or not, I believe most readers will agree that `Promise#then` should behave as if it called `continuify` on callbacks that are passed to it. By doing so, the linking context of the callback will (correctly) be attributed to the context in which `then` was called, regardless of where the Promise was resolved. This means that a (greatly simplified) implementation of `Promise` might roughly look like this:

* `Promise(fn)`:
  * set status of Promise to PENDING
  * runs `fn`, passing in `resolve` as the first argument
* `resolve()` (first argument passed to `Promise` executor):
  * for each `fn` in `promiseFulfillReactions`:
    * schedule `fn` to run on the next tick of the JavaScript MTQ
  * set status of Promise to FULFUILLED
* `Promise.prototype.then(fn)`:
  * __set `fn` to `continuify(fn)`__
  * if status of Promise is PENDING:
    * add `fn` to `promiseFulfillReactions`
  * else:
    * schedule `fn` to run on the next tick of the JavaScript MTQ

(Any details related to Promise rejection are omitted to simplify this model, but theoretically it should behave the same way as `resolve` for context propagation purposes.)

# Automatic Ready Context in Then Before Resolve

Assumption 3 dictates that the `linkContext` of the first running continuation is the `readyContext` of subsequent continuations, so in order for the Promise implementation itself to automatically populate ready context, we must add a `continuify(x)` to the above `Promise` implementation in a way such that a function passed to `then` will run with `x` on the stack, where `x` is a continuation with both link and ready context set wherever `resolve` was called. We add it as follows:

* `Promise(fn)`:
  * set status of Promise to PENDING
  * runs `fn`, passing in `resolve` as the first argument
* `resolve()` (first argument passed to `Promise` executor):
  * __define a function `onNextPromiseMTQTick(fn)` which does the following:__
    * __run `fn()`__
  * __set `onNextPromiseMTQTick` to `continuify(onNextPromiseMTQTick)`__
  * for each `fn` in `promiseFulfillReactions`:
    * __schedule `onNextPromiseMTQTick.bind(fn)` to run on the next tick of the JavaScript MTQ__
  * set status of Promise to FULFILLED
* `Promise.prototype.then(fn)`:
  * set `fn` to `continuify(fn)`
  * if status of Promise is PENDING:
    * add `fn` to `promiseFulfillReactions`
  * else:
    * schedule `fn` to run on the next tick of the JavaScript MTQ

If written this way, then any function that is passed to `then` will be invoked with `onNextPromiseMTQTick` (=`x`) on the stack, _as long as `resolve` hasn't been called yet_. This means that the ready context when `fn` is running will be the context in which `resolve` was called, which is what we want. (The linking context is still the context in which `then` was called.)

# Automatic Ready Context in Then After Resolve

The above doesn't work if `then` is called _after_ a Promise gets resolved, because `then` will directly enqueue its callback on the JS micro-taskqueue. For ready context to be preserved the same way as it is in the then-before-resolve case, the following additional amendments need to be made:

* `Promise(fn)`:
  * set status of Promise to PENDING
  * runs `fn`, passing in `resolve` as the first argument
* `resolve()` (first argument passed to `Promise` executor):
  * __define a function `onNextPromiseMTQTick(fn)` which does the following:__
    * __run `fn()`__
  * __set `onNextPromiseMTQTick` to `continuify(onNextPromiseMTQTick)`__
  * for each `fn` in `promiseFulfillReactions`:
    * __schedule `onNextPromiseMTQTick.bind(fn)` to run on the next tick of the JavaScript MTQ__
  * set status of Promise to FULFILLED
* `Promise.prototype.then(fn)`:
  * set `fn` to `continuify(fn)`
  * if status of Promise is PENDING:
    * add `fn` to `promiseFulfillReactions`
  * else:
    * __schedule `onNextPromiseMTQTick.bind(fn)` to run on the next tick of the JavaScript MTQ__

(Only the last line is changed.) Written this way, this ensures that `onNextPromiseMTQTick` is on the stack no matter whether `resolve` is called before or after `then`, so once again, the ready context when `fn` is running will the context in which `resolve` was called.

This only holds true on the additional assumption that the act of scheduling a function to run on the next tick of the JavaScript MTQ itself _doesn't_ call `continuify`. Therefore, if there also exists a user-accessible API such as `queueMicrotask` that utilizes the MTQ, it must (1) call `continuify`, and (2) _not_ be called from within the Promise implementation.

# Benefits

There are three main benefits I see out of this model:
* It accomplishes what the user expects. We have generally agreed that linking context in a `then` callback should be the context in which `then` was called, while the ready context should be the context in which `resolve` was called. This model, as far as I know, conforms with those expectations. (I see this almost as a base requirement rather than a benefit.)
* My expectation is that it is easily mappable to real Promise API spec. The simplified implementation is already based very loosely off of the spec. Of course, many details were omitted (such as chaining, passing arguments, and rejections) but I think those can be added in without too much additional difficulty. (In other words, it should be straightforward to propose the exact set of changes needed to be made to the Promise API specification.)
* It uses simplified semantics for async context (these are the three assumptions I stated at the beginning). I understand that these aren't yet generally agreed upon, but I want to push for these simplified set of definitions for async context:
  * Calling `continuify(fn)` means: you're claiming responsbility for the invocation of `fn`.
  * When continuation `fn` is invoked, it is possible to know from within `fn` who claimed responsiblity for calling it by getting the value of `getCurrentContext().continuation.linkContext`.
  * Other contexts may have claimed responsibility for other continuations that are on the stack when `fn` was called. The "ready context" is just the linking context of the first such continuation. In other words, the value `getCurrentContext().readyContext` is the same as the first continuation's `getCurrentContext().continuation.linkContext`.
    * This isn't arbitrary -- we can think of ready context as the actual sequence of JavaScript statements that led to the invocation of a function, while the linking context represents the user's intent. They correspond to opposite ends of a stack in a callback: lower in the call stack means low-level and far away from user control, and higher in the call stack means high-level and in the user's own written code.

# Next Steps

I'm open to clarify or discuss any of the ideas presented here.
