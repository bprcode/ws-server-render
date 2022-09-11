const { Conveyor } = require('./conveyor.cjs')

/** Channels and Relays communicate by means of this interface:
 * relay.broadcast([object|primitive] message)
 * 
 * channel.receive([object|primitive] message)
 * 
 * relay.setChannel(channel)
 * 
 * channel.attachRelay(relay)
 * 
 * a ChatChannel must grant permission before each socket is allowed
 * to receive messages.
 * This is done with WebSocketRelay.approveListener(socketId)
*/
class ChatChannel {
    name = 'Default Channel'
    serverId = -1 // An ID not used by any external connections.
    users = {
        lowerCaseNames: new Map(),
        sockets: new Map(),
        sessions: new Map()
    }
    relay = null
    messageProcessor = null
    lastSerial = 0 // Used to enumerate successive broadcasts
    lastTimestamp = 0 // Used to distinguish low-precision timestamps
    maxHistory = process.env.MAX_HISTORY || 50
    maxNameLength = process.env.MAX_NAME_LENGTH || 30
    history = []


    constructor ({ name, relay }) {
        if (name)
            this.name = name

        // May attach relay to channel, or vice versa.
        if (relay)
            this.attachRelay(relay)

        // messageProcessor handles message routing and logic
        initializeChatProcessor(this)
    }

    attachRelay(r) {
        if (this.relay === r)
            return
        this.relay = r
        this.relay?.setChannel?.(this)
    }

    createUser (properties) {
        if(this.users.lowerCaseNames.has(properties.name.toLowerCase()))
            throw new Error(`A user named ${properties.name} already exists.`)
        if(this.users.sessions.has(properties.sessionId))
            throw new Error(`${properties.sessionId} is already in use.`)
        if(this.users.sockets.has(properties.socketId))
            throw new Error(`Socket ${properties.socketId} already assigned.`)

        let u = new ChatUser(properties)
        this.users.lowerCaseNames.set(u.lowerCaseName, u)
        this.users.sessions.set(u.sessionId, u)
        this.users.sockets.set(u.socketId, u)
    }

    getUser (trait) {
        if ('name' in trait)
            return this.users.lowerCaseNames.get(trait.name.toLowerCase())
        if ('sessionId' in trait)
            return this.users.sessions.get(trait.sessionId)
        if ('socketId' in trait)
            return this.users.sockets.get(trait.socketId)
        
        return null
    }

    deleteUser (trait) {
        let u = this.getUser(trait)
            
        if (u) {
            this.users.lowerCaseNames.delete(u.lowerCaseName)
            this.users.sessions.delete(u.sessionId)
            this.users.sockets.delete(u.socketId)
            return true
        }

        log.err('Delete failed -- user not found: ', trait)
        return false
    }

    logUsers () {
        log(`User list holds ${this.users.lowerCaseNames.size} names, `
            + `${this.users.sessions.size} session IDs, `
            + `${this.users.sockets.size} socket IDs`, dim)
        log(`socket`.padEnd(8) + `name`.padEnd(20) + `session`, dim)
        for (const u of this.users.sessions.values())
        log(`${u.socketId}`.padEnd(8),
            `${u.name}`.padEnd(20),
            `${u.sessionId}`)
    }

    updateUser (who, what) {
        let u = this.getUser(who)

        if (u) {
            // need to break old references, set new references
            this.deleteUser(u)
            Object.assign(u, what)
            this.createUser(u)
            return true
        }

        return false
    }

    broadcastUserList () {
        this.receive({
            _set: 'users',
            value: [...this.users.sessions.values()].map(u => u.name),
        })
        this.logUsers()
    }

    // Return an array of historical messages
    // whose serial numbers fall in a specified range.
    retrieve (first = 0, last = this.lastSerial) {
        return this.history.filter(h =>
            h._serial >= first && h._serial <= last)
    }

    // Switch incoming messages and execute actions appropriate to their type.
    receive (message) {
        // Interpret non-object messages as internal text notifications
        if (typeof message !== 'object')
            message = { text: String(message) }

        // If not otherwise marked, assume the message originated internally.
        message._sender ??= this.serverId

        this.messageProcessor.process(message)
    }
}

class ChatUser {
    constructor (properties) {
        this.socketId = properties.socketId ?? null
        this.sessionId = properties.sessionId ?? null
        if (typeof properties.name === 'string') {
            this.name = properties.name
        } else {
            this.name = 'Default-' + ((Math.random() * 0x40000000) | 0)
        }
    }

    get lowerCaseName () {
        return this.name.toLowerCase()
    }
}

function initializeChatProcessor (channel) {
    channel.messageProcessor = new Conveyor()
    channel.messageProcessor
        .use({ _event: 'connect' }, (m, end) => {
            // Do not broadcast connections
            end()
        })
        .use({ _event: 'disconnect' }, (m, end) => {
            let u = channel.getUser({ socketId: m._sender })
            if (u) {
                channel.deleteUser(u)
            } else {
                u = {name: 'Unknown user'}
            }
            channel.receive({
                text: `${u.name} disconnected.`,
                _remember: true
            })
            log('Server processed disconnect for ' + u.name, dim)
            channel.broadcastUserList()

            end()
        })
        // Handle rename requests
        .use({ request: 'rename' }, (m, end) => {
            // Enforce a maximum username length
            if (m.text.length > channel.maxNameLength)
                m.text = m.text.slice(0, channel.maxNameLength) + '...'

            log(`❕ >>> rename request content: <${m._sender}> ${m.text}`, pink)
            let currentRecord = channel.getUser({ socketId: m._sender })
            let nameHolder = channel.getUser({ name: m.text })

            // If no one else holds the name, approve the request.
            if ( ! nameHolder ) {
                log(`(1) Not in use -- approving request`, pink)
                channel.receive({
                    text: `${currentRecord.name} renamed to ${m.text}`,
                    _remember: true
                })
                channel.receive({
                    _set: 'rename',
                    value: [currentRecord.name, m.text]
                })

                channel.updateUser({ socketId: m._sender}, { name: m.text })
                channel.broadcastUserList()

            } else if ( nameHolder.sessionId === currentRecord.sessionId ) {
                log(`(2) Redundant rename request.`, pink)
                channel.receive({
                    to: m._sender,
                    text: `You are already named ${m.text}.`
                })
                
            } else {
                log(`(3) Rejecting request -- in use`, pink)
                channel.receive({
                    text: `Name already in use. (${m.text})`,
                    to: m._sender,
                })
                channel.receive({
                    to: m._sender,
                    _set: 'name',
                    value: currentRecord.name
                })
            }

            end()
        })
        // Serve rename requests
        .use({ request: 'identify' }, (m, end) => {
            log(`Got identify request: `, pink, m)
            // Allow the socket to receive messages once it has
            // made some attempt to identify itself:
            channel.relay.approveListener(m._sender)

            // Enforce a maximum username length
            if (m.name.length > channel.maxNameLength)
                m.name = m.name.slice(0, channel.maxNameLength) + '...'

            // Figure out what to call this user, create a record for it:
            // If name already in use or unspecified...
            if (channel.getUser({ name: m.name }) || m.name === '') {
                let suggestedName = generateRandomName(channel)
                
                channel.createUser({
                    socketId: m._sender,
                    sessionId: m.sid,
                    name: suggestedName
                })
                
                log('Name already in use -- create/instructing name to:', pink,
                    channel.getUser({ socketId: m._sender}).name, pink)
            // Otherwise, if the name is available...
            } else {
                log(`Name available. Creating user:`
                    + ` <${m._sender}>, ${m.name}, ${m.sid}`)
                channel.createUser({
                    socketId: m._sender,
                    sessionId: m.sid,
                    name: m.name
                })
            }

            channel.receive({
                to: m._sender,
                _set: 'name',
                value: channel.getUser({ socketId: m._sender}).name
            })

            // Notify the listener of the last used message serial number,
            // in case the listener wants to request history.
            channel.receive({
                to: m._sender,
                _set: 'lastSeen',
                value: channel.lastSerial
            })

            channel.receive({
                text: channel.getUser({ socketId: m._sender}).name
                        + ' joined.',
                _remember: true
            })

            channel.broadcastUserList()
            end()
        })
        // Serve history requests
        .use({ request: 'history' }, (m, end) => {
            let first = m.first ?? 0
            let last = m.last ?? channel.lastSerial
            let records = channel.retrieve(first, last)
            if( records.length )
                channel.receive({
                    to: m._sender,
                    history: records,
                })
            end()
        })
        // Route direct messages -- do not pass them on for general broadcast
        .use({ recipient: '*' }, (m, end) => {
            let whom = channel.getUser({ name: m.recipient })
            // If recipient not found...
            if ( ! whom ) {
                channel.receive({
                    to: m._sender,
                    text: 'Recipient not found.'
                })
                log('unable to match recipient.', pink)
                return end()
            }

            m.name = channel.getUser({ socketId: m._sender }).name
            log(`Direct routing from ${m.name} to ${whom.name}`, blue)
            // Send to recipient...
            channel.receive({
                to: whom.socketId,
                name: `${m.name} → ${whom.name}`,
                text: m.text
            })

            // Also send acknowledgement copy to sender
            if (m._sender !== whom.socketId)
                channel.receive({
                    to: m._sender,
                    name: `${m.name} → ${whom.name}`,
                    text: m.text
                })

            end()
        })
        // Attempt to look up username, mark normal transmissions for storage.
        .use({ _event: 'transmit' }, m => {
            m.name = channel.getUser({ socketId: m._sender }).name
            m._remember = true
        })
        // Timestamp message
        .use(m => {
            // Obtain a low-precision timestamp to discourage timing attacks (?)
            // Adjust to ensure timestamps always count up.
            let timestamp = 100 * parseInt(Date.now() / 100)
            if (timestamp <= channel.lastTimestamp) {
                timestamp = channel.lastTimestamp + 1
            }
            channel.lastTimestamp = timestamp
            m._time = timestamp
        })
        // Remove internal sender poperty before recording or broadcasting
        // this message:
        .use(m => {
            delete m._sender
        })
        // Keep a record of messages flagged for storage.
        .use({ _remember: true }, m => {
            // _remember is an internal flag which need not be recorded:
            delete m._remember

            m._serial = ++channel.lastSerial
            channel.history.push(m)
            log(`Remembering) ${channel.name}> [${m._serial}] `
                +`${m.name}: ${m.text} `, yellow,
                `(${channel.history.length}/${channel.maxHistory})`)

            // Remove 30% of the messages whenever the limit is exceeded.
            if (channel.history.length > channel.maxHistory) {
                channel.history = channel.history.slice(-channel.maxHistory * 0.7)
                log('Trimmed history: ', pink,
                    channel.history.map(h => h._serial).join(', '))
            }
        })
        // Finally, broadcast messages which reached this point.
        .use(m => {
            channel.relay?.broadcast?.(m)
        })
}

// WebSocketRelay handles the management of WebSocket connections
// and forwards messages to and from the chat server.
// Messages may consist of any JSON-parsable string, however
// field keys beginning with an _underscore are reserved for internal
// server use.
// Any other fields should be considered unsafe user input.
// Any client-sent messages containing underscore-prepended keys
// are forbidden from reaching the server.
class WebSocketRelay {
    static connectionID = 0
    sockets = new Set()
    socketInfo = new WeakMap()
    channel = null

    constructor (channel = null) {
        // May attach channel to relay, or vice versa.
        this.setChannel(channel)
    }

    setChannel (c) {
        if (this.channel === c)
            return
        this.channel = c
        this.channel?.attachRelay?.(this)
    }

    resetIdleTimer (s) {
        if (this.socketInfo.has(s)) {
            let info = this.socketInfo.get(s)
            if ('timeout' in info)
                clearTimeout(info.timeout)

            info.timeout = setTimeout(() => {
                s.close()
            }, process.env.IDLE_TIMEOUT || 300000)
        }
    }

    approveListener (socketId) {
        for (const s of this.sockets) {
            let info = this.socketInfo.get(s)
            if (info.id === socketId) {
                info.canListen = true
                break
            }
        }
    }

    receiveConnection (s) {
        if ( this.sockets.has(s) )
            return false

        this.sockets.add(s)
        this.socketInfo.set(s, {
            id: WebSocketRelay.connectionID++,
            canListen: false
        })
        this.resetIdleTimer(s)

        let id = this.socketInfo.get(s).id
        log(`Connection to socket with id=${id}. `
            + `Now listening to ${this.sockets.size} socket(s)`, blue)

        this.channel.receive(
            {   _sender: id,
                _event: 'connect'
            })

        // Read buffer as string, parse to object, insert system properties
        s.on('message', data => {
            try {
                this.resetIdleTimer(s)

                let m = JSON.parse(String(data))
                // Messages are turned into objects
                // before channels receive them.
                if (typeof m !== 'object')
                    m = { text: String(m) }

                if (containsForbiddenFields(m)) {
                    log.err('Blocking message due to forbidden fields.')
                    return
                }

                m._sender = id
                m._event = 'transmit'
                
                this.channel.receive(m)

            } catch (er) {
                log.err('Transmission error: ', er.message, er.stack)
            }
        })
        s.on('close', () => {
            this.channel.receive(
                {   _sender: id,
                    _event: 'disconnect'
                })
            this.socketInfo.delete(s)
            this.sockets.delete(s)
        })

        return true
    }

    broadcast (m) {
        // Wrap plain strings in objects
        if (typeof m === 'string')
            m = { text: m }

        // Convert objects to JSON
        let json = JSON.stringify(m)

        // if addressed, broadcast to specific listeners
        if ('to' in m) {
            // For a single recipient, wrap with an array
            // before iterating to find the right socket.
            if ( ! Array.isArray(m.to) )
                m.to = [m.to]

            for (const s of this.sockets) {
                let info = this.socketInfo.get(s)
                // Skip listeners who have not been approved
                if (info.canListen !== true)
                    continue

                if (m.to.includes(info.id))
                    s.send(json)
            }

            return
        }
        // Otherwise, broadcast to all approved listeners
        for (const s of this.sockets) {
            if (this.socketInfo.get(s).canListen)
                s.send(json)
        }
    }
}

function containsForbiddenFields (message, recursionDepth = 0) {
    if (recursionDepth > 9) {
        log.err('Forbidden message: too many sub-fields.')
        return true
    }
    for (const key in message) {
        if (/^_/.test(key)) {
            log.err(`Forbidden key value: ${key}.`)
            return true
        }

        // Recursively check sub-objects.
        if (typeof message[key] === 'object') {
            if (containsForbiddenFields(message[key], recursionDepth+1 ))
                return true
        }
    }
    return false
}

function generateRandomName (channel) {
    const adjectives = [
        'Persnickety',
        'Spectacular',
        'Winsome',
        'Beguiling',
        'Gregarious',
        'Modest',
        'Vaporous',
        'Harmonious',
        'Adamant',
        'Adroit',
        'Frolicsome',
        'Munificent',
        'Voluble',
    ]
    
    const animals = [
        'Aardvark',
        'Anteater',
        'Armadillo',
        'Badger',
        'Coatimundi',
        'Cormorant',
        'Octopus',
        'Crocodile',
        'Gecko',
        'Parakeet',
        'Shark',
        'Stork',
        'Toucan',
        'Ostrich',
        'Ocelot',
        'Pangolin',
        'Quokka',
    ]

    let name = animals[Math.floor(Math.random() * animals.length)]

    // If the noun is in use, add an adjective...
    if (channel.getUser({ name })) {
        name = adjectives[Math.floor(Math.random() * adjectives.length)]
                + ' ' + name

        // If the name is still in use, add a number to distinguish them.
        let possibleName = name
        let count = 2
        while (channel.getUser({ name: possibleName })) {
            possibleName = name + '-' + count
            count++
        }

        name = possibleName
    }
    
    return name
}

module.exports = { ChatChannel, WebSocketRelay }
