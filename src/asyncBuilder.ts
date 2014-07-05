﻿import references = require('references');
import assert = require('assert');
import _ = require('./util');
import Builder = AsyncAwait.Async.Builder;
import Protocol = AsyncAwait.Async.Protocol;
import Options = AsyncAwait.Async.Options;
import ProtocolOverrides = AsyncAwait.Async.ProtocolOverrides;
import Coroutine = AsyncAwait.Coroutine;
export = asyncBuilder;


//TODO: testing...
import Fiber = require('./fibers');
import semaphore = require('./semaphore');
import fiberPool = require('./fiberPool');


/** Configuration for createSuspendableFunction(). See that function's comments for more details. */
var SUSPENDABLE_DEBUG = false;


// Bootstrap an initial async builder using a no-op protocol.
var asyncBuilder = createAsyncBuilder<Builder>(_.empty, {}, {
    invoke: (co) => { },
    return: (co, result) => { },
    throw: (co, error) => { },
    yield: (co, value) => { },
    finally: (co) => { }
});


/** Creates a new async builder function using the specified protocol settings. */
function createAsyncBuilder<TBuilder extends Builder>(protocolFactory: (options: Options, baseProtocol: Protocol) => ProtocolOverrides, options: Options, baseProtocol: Protocol) {

    // Instantiate the protocol by calling the provided factory function.
    var protocol: Protocol = <any> _.mergeProps({}, baseProtocol, protocolFactory(options, baseProtocol));

    // Create the builder function.
    var builder: TBuilder = <any> function asyncBuilder(invokee: Function) {

        // Validate the argument, which is expected to be a closure defining the body of the suspendable function.
        assert(arguments.length === 1, 'async builder: expected a single argument');
        assert(_.isFunction(invokee), 'async builder: expected argument to be a function');

        // Create and return an appropriately configured suspendable function for the given protocol and body.
        return createSuspendableFunction(protocol, invokee, options);
    };

    // Tack on the protocol and options properties, and the mod() method.
    builder.protocol = protocol;
    builder.options = options;
    builder.mod = createModMethod(protocol, protocolFactory, options, baseProtocol);

    // Return the async builder function.
    return builder;
}


/** Creates a mod method appropriate to the given protocol settings. */
function createModMethod(protocol, protocolFactory, options, baseProtocol) {
    return function mod() {

        // Validate the arguments.
        var len = arguments.length;
        assert(len > 0, 'mod(): expected at least one argument');
        var arg0 = arguments[0], hasProtocolFactory = _.isFunction(arg0);
        assert(hasProtocolFactory || len === 1, 'mod(): invalid argument combination');

        // Determine the appropriate options to pass to createAsyncBuilder.
        var opts = {};
        if (!hasProtocolFactory) _.mergeProps(opts, options);
        _.mergeProps(opts, hasProtocolFactory ? arguments[1] : arg0);

        // Determine the appropriate protocolFactory and baseProtocol to pass to createAsyncBuilder.
        var newProtocolFactory = hasProtocolFactory ? arg0 : protocolFactory;
        var newBaseProtocol = hasProtocolFactory ? protocol : baseProtocol;

        // Delegate to createAsyncBuilder to return a new async builder function.
        return createAsyncBuilder(newProtocolFactory, opts, newBaseProtocol);
    }
}


/**
 *  Creates a suspendable function configured for the given protocol and invokee.
 *  This function is not on the hot path, but the suspendable function it returns
 *  can be hot, so here we trade some time (off the hot path) to make the suspendable
 *  function as fast as possible. This includes safe use of eval (safe because the
 *  input to eval is completely known and safe). By using eval, the resulting function
 *  can be pieced together more optimally, as well as having the expected arity and
 *  preserving the invokee's function name and parameter names (to help debugging).
 *  NB: By setting SUSPENDABLE_DEBUG to true, a less optimised non-eval'd function
 *  will be returned, which is helpful for step-through debugging sessions. However,
 *  this function will not report the correct arity (function.length) in most cases.
 */
function createSuspendableFunction(protocol, invokee, options: Options) {

    // Declare the general shape of the suspendable function.
    function $SUSPENDABLE_TEMPLATE($ARGS) {

        // Code for the fast path will be injected here.
        if (arguments.length === $ARGCOUNT) {
            $FASTPATH
        }

        // Distribute arguments between the invoker and invokee functions, according to their arities.
        var invokeeArgCount = arguments.length - invokerArgCount;
        var invokeeArgs = new Array(invokeeArgCount), invokerArgs = new Array(invokerArgCount + 1);
        for (var i = 0; i < invokeeArgCount; ++i) invokeeArgs[i] = arguments[i];
        for (var j = 1; j <= invokerArgCount; ++i, ++j) invokerArgs[j] = arguments[i];

        // Create a coroutine instance to hold context information for this call.
        var co = createCoroutine(protocol, () => invokee.apply(this, invokeeArgs));

        // Pass execution control over to the invoker.
        invokerArgs[0] = co;
        return protocol.invoke.apply(null, invokerArgs);
    }

    // The $SUSPENDABLE_TEMPLATE function will harmlessly close over these when used in SUSPENDABLE_DEBUG mode.
    // The initial values ensure the that fast path in the template is never hit.
    var $ARGCOUNT = -1, $FASTPATH = null;

    // Get the invoker's arity, which is needed inside the suspendable function.
    var invokerArgCount = protocol.invoke.length - 1;

    // At this point, the un-eval'd $SUSPENDABLE_TEMPLATE can be returned directly if in SUSPENDABLE_DEBUG mode.
    if (SUSPENDABLE_DEBUG) return $SUSPENDABLE_TEMPLATE;

    // Get all parameter names of the invoker and invokee.
    var invokerParamNames = _.getParamNames(protocol.invoke).slice(1); // Skip the 'co' parameter.
    var invokeeParamNames = _.getParamNames(invokee);

    // Ensure there are no clashes between invoker/invokee parameter names.
    for (var i = 0; i < invokeeParamNames.length; ++i) {
        var paramName = invokeeParamNames[i];
        if (invokerParamNames.indexOf(paramName) === -1) continue;
        throw new Error("async builder: invoker and invokee both have a parameter named '" + paramName + "'");
    }

    // The two parameter lists together form the parameter list of the suspendable function.
    var allParamNames = invokeeParamNames.concat(invokerParamNames);

    // Stringify $SUSPENDABLE_TEMPLATE just once and cache the result in a module variable.
    suspendableTemplateSource = suspendableTemplateSource || $SUSPENDABLE_TEMPLATE.toString(); 

    // Assemble the source code for the suspendable function's fast path.
    // NB: If the calling context need not be preserved, we can avoid using the slower Function.call().
    var fastpath = 'var self = this, co = createCoroutine(protocol, function () { return invokee';
    if (options.canDiscardContext) fastpath += '(' + invokeeParamNames.join(', ');
    else fastpath += '.call(self' + (invokeeParamNames.length ? ', ' + invokeeParamNames.join(', ') : '');
    fastpath += '); }); return protocol.invoke(co' + (invokerParamNames.length ? ', ' + invokerParamNames.join(', ') : '') + ');'

    // Substitute all placeholders in the template function to get the final source code.
    var source = suspendableTemplateSource
        .replace('$SUSPENDABLE_TEMPLATE', 'suspendable_' + invokee.name)
        .replace('$ARGS', allParamNames.join(', '))
        .replace('$ARGCOUNT', '' + allParamNames.length)
        .replace('$FASTPATH', fastpath);

    // Eval the source code into a function, and return it. It must be eval'd inside
    // this function to close over the variables defined here.
    var result;
    eval('result = ' + source);
    return result;
}


// This module variable holds the cached source of $SUSPENDABLE_TEMPLATE, defined above.
var suspendableTemplateSource;


//TODO: ...
function createCoroutine(protocol: Protocol, body: () => void): Coroutine {

    var co: Coroutine = <any> new Object();
    var fiber = null;

    //========================================
    co.enter = (error?, value?) => {

        //TODO:... use args

        if (!fiber) {
            assert(arguments.length === 0, 'enter: initial call must have no arguments');

            var _start = () => {
                fiberPool.inc();
                fiber = Fiber(makeFiberBody());
                fiber.co = co;
                fiber.yield = value => protocol.yield(co, value); //TODO: improve?
                setImmediate(() => fiber.run()); //TODO: best place for setImmediate?
            };

            var isTopLevel = !Fiber.current;
            if (isTopLevel)
                //TODO PERF: only use semaphore if maxConcurrency is specified
                return semaphore.enter(() => _start());
            else
                _start();
            
        }
        else {
            // TODO: explain...
            if (error) setImmediate(() => { fiber.throwInto(error); });
            else setImmediate(() => { fiber.run(value); });

            //TODO: was...
            //setImmediate(() => fiber.run()); //TODO: best place for setImmediate?
        }
    };



    co.leave = (value?) => {
        //TODO: assert is current...
        Fiber.yield();
    };



    function makeFiberBody() {
        var tryBlock = () => protocol.return(co, body());
        var catchBlock = err => protocol.throw(co, err);
        var finallyBlock = () => { protocol.finally(co); dispose(co); }

        // V8 may not optimise the following function due to the presence of
        // try/catch/finally. Therefore it does as little as possible, only
        // referencing the optimisable closures prepared above.
        return function fiberBody() {
            try { tryBlock(); }
            catch (err) { catchBlock(err); }
            finally { setImmediate(finallyBlock); }
        };
    }
    function dispose(co: Coroutine) {
        fiberPool.dec();
        fiber.co = null;
        fiber = null;
        semaphore.leave();
    }
    //========================================



    return co;
}
