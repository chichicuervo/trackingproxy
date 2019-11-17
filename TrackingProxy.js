import { cloneWith, cloneDeepWith, isEmpty } from 'lodash';

const cloneCustomizer = (value, deep) => {
    // if (isMap(target)) return new Map(target)
    // if (isSet(target)) return new Set(target)
    if (value instanceof TrackingProxy) return deep ? cloneDeep(value.inner) : clone(value.inner)
}

const clone = value => {
    return cloneWith(value, value => cloneCustomizer(value))
}

const cloneDeep = value => {
    return cloneDeepWith(value, value => cloneCustomizer(value, true))
}

const asArray = (...values) => {
    let out = []
    for (let value of values) {
        out = Array.isArray(value)
            ? [...out, ...value]
            : value
            ? [...out, value]
            : out
    }
    return out.filter(i => !!i)
}

export const trackable = Symbol('TrackingProxy')

export default class TrackingProxy {
    [trackable] = true
    _tracked = {}
    _options = {}
    _history = []

    static _trackable = trackable // 'TrackingProxy'

    static [Symbol.hasInstance](instance) {
        const { constructor: { _trackable: __trackable }, _trackable } = instance || {}

        return  ( __trackable || _trackable ) === trackable
    }

    static clone(value, { deepClone } = {}) {
        return deepClone ? cloneDeep(value) : clone(value)
    }

    static hydrate(history, { trackingClass, ...options } = {}) {
        trackingClass = trackingClass || TrackingProxy
        // history = cloneDeep(history)

        if (!(trackingClass instanceof TrackingProxy)) {
            throw new Error ('Invalid TrackingProxy class')
        }

        let obj
        if (typeof trackingClass !== 'function' && typeof trackingClass === 'object') {
            obj = trackingClass
            obj.setOptions(options)

        } else if (trackingClass.factory) {
            obj = trackingClass.factory(options)

        } else {
            obj = new trackingClass
            obj.setOptions(options)
        }

        return obj.applyHistory(history)
    }

    constructor(obj, history, options = {}) {
        options && this.setOptions(options)
        history && this.setHistory(history)

        const { byProps, byClone, prefix, onlyChanges, deepClone } = this.options

        const doClone = value => {
            return !Object.isFrozen(value) || byClone || deepClone ? this.constructor.clone(value, { deepClone }) : value
        }

        if (obj instanceof TrackingProxy) {
            options || this.setOptions(obj.options)
            this._tracked = doClone(obj.inner)
            !onlyChanges && this.history !== obj.history && this.history.push(...obj.history)

        } else if (byProps) {
            this._tracked = {}
            !onlyChanges && obj !== undefined && this.history.push(['+', asArray(prefix), {}])

            const entries = obj.entries && obj.entries() || Object.entries(obj)
            const proxied = this.setProxy(this._tracked)

            for (let [prop, value] of entries) {
                proxied[prop] = doClone(value)
            }

            return proxied

        } else {
            this._tracked = obj !== undefined ? doClone(obj) : {}

            if (obj !== undefined && !onlyChanges) {
                this.history.push(['+', asArray(prefix), doClone(obj)])
            }
        }

        return this.setProxy(this._tracked)
    }

    * [Symbol.iterator] () {
        for (let key in this) {
            yield this[key]
        }
    }

    * entries() {
        for (let key in this) {
            yield [key, this[key]]
        }
    }

    * asTree(prefix) {
        prefix = Array.isArray(prefix) ? prefix : prefix ? [prefix] : []

        for (let key in this) {
            const value = this[key]
            if (value instanceof TrackingProxy) {
                yield* value.asTree([...prefix, key])
            } else {
                yield [[...prefix, key], value]
            }
        }
    }

    get inner() {
        return this._tracked
    }

    valueOf() {
        return this.inner
    }

    get history () {
        return this._history
    }

    setHistory(history) {
        const { debug: DEBUG } = this.options
        DEBUG && console.log('set history', history)

        if (!Array.isArray(history) && !history.push instanceof Function) {
            throw new Error ('Invalid History Object')
        }

        return this._history = history
    }

    get options() {
        return this._options || {}
    }

    setOptions(options = {}) {
        const { debug: DEBUG } = this._options || {}
        const { debug: _DEBUG } = options || {}

        (DEBUG || _DEBUG) && console.log('set options', options)

        this._options = {
            ...this._options,
            ...options
        }
    }

    setProxy(obj) {
        const { debug: DEBUG } = this.options
        DEBUG && console.log('set proxy')

        return new Proxy(obj, {
            defineProperty: this.definePropertyHandler(),
            deleteProperty: this.deletePropertyHandler(),
            has: this.hasHandler(),
            get: this.getHandler(),
            set: this.setHandler(),
        })
    }

    isPropEnumerable(prop, obj = undefined) {
        return !prop.startsWith('_')
    }

    getPropertyState(prop, obj = undefined) {
        obj = obj || this.inner

        const history = Array.isArray(this.history) || !!this.history
        const { enumerable, writable, set: setter } = Object.getOwnPropertyDescriptor(obj, prop) || {}
        const exists = !!Object.getOwnPropertyDescriptor(this, prop)

        return !exists && {
            setable: (writable === undefined && setter === undefined) || writable || !!setter,
            trackable: history && (enumerable === undefined || enumerable) && this.isPropEnumerable(prop, obj)
        } || {}
    }

    applyHistory(...history) {
        history = history.length === 1 ? history.shift() : history

        if (!Array.isArray(history) && !history.push instanceof Function) {
            throw new Error ('Invalid History Object')
        }

        const { onlyChanges, keepHydrateHistory } = this.options

        for (let item of history.entries()) {
            let [index, [op, path, value]] = cloneDeep(item)

            if (index === 0 && path.length === 0 && isEmpty(value)) continue
            if (index === 0 && path.length === 0 && !isEmpty(value)) { console.log ('TODO: what to do when 1st history item not empty?') ; continue }
            if (index !== 0 && path.length === 0) throw new Error ('Invalid History. Empty path only allowed for index 0')

            let prop, temp = this
            path = Array.from(path) // stupid clone of Array

            do {
                prop = path.shift()
                if (path.length) temp = temp[prop]
            } while (path.length)

            if (op === '+') {
                temp[prop] = value
            } else if (op === '-') {
                delete temp[prop]
            } else {
                new Error('Invalid Operation in History')
            }
        }

        !keepHydrateHistory && this.setHistory(onlyChanges ? [] : cloneDeep(history))

        return this
    }

    applyParentHandler() {
        const getOptions = () => this.options
        const setOptions = options => this.setOptions(options)
        const getHistory = () => this.history
        const setHistory = history => this.setHistory(history)

        return (prop, parent) => {
            if (! parent instanceof TrackingProxy) {
                throw new Error ('Parent must be instance of TrackingProxy')
            }

            const { prefix: parent_pfx, onlyChanges } = parent.options
            const { prefix: prefix } = getOptions()

            // console.log('prefixes', parent_pfx, prop, prefix)
            // console.log('histories', parent.history, getHistory())

            setOptions({
                onlyChanges,
                prefix: asArray(parent_pfx, prop, prefix)
            })

            const history = getHistory()

            if (parent.history !== history) {
                const { prefix: prefix } = this.options

                const out = !onlyChanges ? history.map(([op, path, value]) => [op, asArray(prefix, path), value]) : undefined

                setHistory(parent.history)

                return out
            }
        }
    }

    definePropertyHandler() {
        const { debug: DEBUG } = this.options

        const enumerable = (obj, prop) => this.isPropEnumerable(prop, obj)

        return (obj, prop, desc) => {
            DEBUG && console.log('defineProperty', prop, obj, desc)
            DEBUG && console.log('property', prop, Object.getOwnPropertyDescriptor(obj, prop))

            return Reflect.defineProperty(obj, prop, {
                ...desc,
                enumerable: enumerable(obj, prop),
            })
        }
    }

    deletePropertyHandler() {
        const { debug: DEBUG } = this.options

        const getPropertyState = (obj, prop) => this.getPropertyState(prop, obj)
        const getHistory = () => this.history
        const getOptions = () => this.options
        const clone = value => this.constructor.clone(value, this.options)

        return (obj, prop) => {
            DEBUG && console.log('deleteProperty', prop)
            DEBUG && console.log('exists', prop, Reflect.has(obj, prop))

            const { trackable, setable } = getPropertyState(obj, prop)
            const { prefix } = getOptions()
            const history = getHistory()

            trackable && Reflect.has(obj, prop) && history.push(
                ['-', asArray(prefix, prop), clone(Reflect.get(obj, prop))]
            )

            return setable && Reflect.deleteProperty(obj, prop)
        }
    }

    hasHandler() {
        const { debug: DEBUG } = this.options

        return (obj, prop) => {
            DEBUG && console.log('has', prop)
            return Reflect.has(obj, prop)
        }
    }

    getHandler() {
        const { debug: DEBUG } = this.options

        return (obj, prop, proxy) => {
            DEBUG && console.log('get', prop)

            return Reflect.has(this, prop)
                ? Reflect.get(this, prop)
                : Reflect.has(obj, prop)
                ? Reflect.get(obj, prop, proxy)
                : undefined
        }
    }

    setHandler() {
        const { debug: DEBUG } = this.options

        const getPropertyState = (obj, prop) => this.getPropertyState(prop, obj)
        const getHistory = () => this.history
        const getOptions = () => this.options
        const clone = value => this.constructor.clone(value, this.options)

        return (obj, prop, value, proxy) => {
            if (Reflect.has(this, prop)) {
                return Reflect.set(this, prop, value)
            }

            DEBUG && console.log('set', prop, value instanceof Object ? value.toString() : value)
            DEBUG && console.log('exists', prop, Reflect.has(obj, prop))
            DEBUG && console.log('property', prop, Object.getOwnPropertyDescriptor(obj, prop))

            const { trackable, setable } = getPropertyState(obj, prop)
            const { prefix, autoTrack, ...options } = getOptions()

// console.log('as', prefix, prop, value instanceof TrackingProxy)

            if (autoTrack && value instanceof Object && !(value instanceof TrackingProxy)) {
                // value = new TrackingProxy(value, undefined, getOptions())
                value = new TrackingProxy(value, undefined, { autoTrack, ...options})
            }

            const child_hst = value instanceof TrackingProxy
                && value.applyParentHandler()(prop, this)
                || [ ['+', asArray(prefix, prop), clone(value)] ]

            if (trackable) {
                const history = getHistory()
// console.log('ch', prop, child_hst)
                Reflect.has(obj, prop)
                    ? history.push(
                        ['-', asArray(prefix, prop), clone(Reflect.get(obj, prop, proxy))],
                        ...child_hst,
                        // ['+', asArray(prefix, prop), clone(value)]
                    ) : child_hst.length && history.push(
                        ...child_hst,
                        // ['+', asArray(prefix, prop), clone(value)]
                    )
            }

            return setable && Reflect.set(obj, prop, value, proxy)
        }
    }

}
