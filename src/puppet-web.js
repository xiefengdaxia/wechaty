/**
 *
 * wechaty: Wechat for Bot. and for human who talk to bot/robot
 *
 * Class PuppetWeb
 *
 * use to control wechat in web browser.
 *
 * Licenst: ISC
 * https://github.com/zixia/wechaty
 *
 */

/**************************************
 *
 * Class PuppetWeb
 *
 ***************************************/
const util  = require('util')
const fs    = require('fs')
const co    = require('co')

const log = require('./npmlog-env')

const Puppet  = require('./puppet')
const Contact = require('./contact')
const Room    = require('./room')

const Message = require('./message')

const Server  = require('./puppet-web-server')
const Browser = require('./puppet-web-browser')
const Bridge  = require('./puppet-web-bridge')

const Event = require('./puppet-web-event')

class PuppetWeb extends Puppet {
  constructor(options) {
    super()
    options = options || {}
    this.port     = options.port || 8788 // W(87) X(88), ascii char code ;-]
    this.head     = options.head
    this.session  = options.session  // if not set session, then dont store session.

    this.userId = null  // user id
    this.user   = null  // <Contact> of user self
  }

  toString() { return `Class PuppetWeb({browser:${this.browser},port:${this.port}})` }

  init() {
    log.verbose('PuppetWeb', `init() with port:${this.port}, head:${this.head}, session:${this.session}`)

    return co.call(this, function* () {

      yield this.initAttach(this)
      log.verbose('PuppetWeb', 'initAttach() done')

      yield this.initServer()
      log.verbose('PuppetWeb', 'initServer() done')

      yield this.initBrowser()
      log.verbose('PuppetWeb', 'initBrowser() done')

      yield this.initBridge()
      log.verbose('PuppetWeb', 'initBridge() done')
    })
    .catch(e => {   // Reject
      log.error('PuppetWeb', 'init exception: %s', e.message)
      throw e
    })
    .then(() => {   // Finally
      log.verbose('PuppetWeb', 'init() done')
      return this   // for Chaining
    })
  }

  quit() {
    log.verbose('PuppetWeb', 'quit()')

    return co.call(this, function* () {
      if (this.bridge)  {
        yield this.bridge.quit().catch(e => { // fail safe
          log.warn('PuppetWeb', 'quite() bridge.quit() exception: %s', e.message)
        })
        this.bridge = null
      } else { log.warn('PuppetWeb', 'quit() without a bridge') }

      if (this.server) {
        yield this.server.quit()
        this.server = null
      } else { log.warn('PuppetWeb', 'quit() without a server') }

      if (this.browser) {
        yield (this.browser.quit().catch(e => { // fail safe
          log.warn('PuppetWeb', 'quit() browser.quit() exception: %s', e.message)
        }))
        this.browser = null
      } else { log.warn('PuppetWeb', 'quit() without a browser') }

      yield this.initAttach(null)
    })
    .catch(e => { // Reject
      log.error('PuppetWeb', 'quit() exception: %s', e.message)
      throw e
    })
    .then(() => { // Finally, Fail Safe
      log.verbose('PuppetWeb', 'quit() done')
      return this   // for Chaining
    })
  }

  initAttach(puppet) {
    log.verbose('PuppetWeb', 'initAttach()')
    Contact.attach(puppet)
    Room.attach(puppet)
    Message.attach(puppet)
    return Promise.resolve(!!puppet)
  }
  initBrowser() {
    log.verbose('PuppetWeb', 'initBrowser()')
    const browser = this.browser  = new Browser({head: this.head})

    browser.on('dead', Event.onBrowserDead.bind(this))

    // fastUrl is used to open in browser for we can set cookies.
    // backup: 'https://res.wx.qq.com/zh_CN/htmledition/v2/images/icon/ico_loading28a2f7.gif'
    const fastUrl = 'https://wx.qq.com/zh_CN/htmledition/v2/images/webwxgeticon.jpg'

    return co.call(this, function* () {
      yield browser.init()
      yield browser.open(fastUrl)
      if (this.session) {
        yield browser.loadSession(this.session)
        .catch(e => { // fail safe
          log.verbose('PuppetWeb', 'browser.loadSession(%s) exception: %s', this.session, e.message || e)
        })
      }
      yield browser.open()
      return browser // follow func name meaning
    }).catch(e => {
      log.error('PuppetWeb', 'initBrowser() exception: %s', e.message)
      throw e
    })
  }
  initBridge() {
    log.verbose('PuppetWeb', 'initBridge()')
    this.bridge = new Bridge({
      puppet:   this // use puppet instead of browser, is because browser might change(die) duaring run time
      , port:   this.port
    })

    return this.bridge.init()
    .catch(e => {
      if (this.browser.dead()) {
        log.warn('PuppetWeb', 'initBridge() found browser dead, wait it to restore')
      } else {
        log.error('PuppetWeb', 'initBridge() exception: %s', e.message)
        throw e
      }
    })
  }
  initServer() {
    log.verbose('PuppetWeb', 'initServer()')
    const server = new Server({port: this.port})

    server.on('scan'    , Event.onServerScan.bind(this))
    server.on('login'   , Event.onServerLogin.bind(this))
    server.on('logout'  , Event.onServerLogout.bind(this))
    server.on('message' , Event.onServerMessage.bind(this))
    server.on('unload'  , Event.onServerUnload.bind(this))

    server.on('connection', Event.onServerConnection.bind(this))
    server.on('disconnect', Event.onServerDisconnect.bind(this))
    server.on('log'       , Event.onServerLog.bind(this))
    server.on('ding'      , Event.onServerDing.bind(this))

    this.server = server
    return this.server.init()
    .catch(e => {
      log.error('PuppetWeb', 'initServer() exception: %s', e.message)
      throw e
    })
  }

  // feed me in time(after 1st feed), or I'll restart system
  watchDog(data, options) {
    log.silly('PuppetWeb', 'watchDog(%s)', data)
    options = options || {}
    const timeout = options.timeout || 60000 // 60s default. can be override in options but be careful about the number zero(0)
    const type   =  options.type    || 'food'  // just a name

    if (this.watchDogTimer) { clearTimeout(this.watchDogTimer) }
    this.watchDogTimer = setTimeout(() => this.watchDogReset(timeout), timeout)
    this.watchDogTimer.unref() // dont block quit

    const SAVE_SESSION_INTERVAL = 5 * 60 * 1000 // 5 mins
    if (this.session) {
      if (this.watchDogLastSaveSession && Date.now() - this.watchDogLastSaveSession > SAVE_SESSION_INTERVAL) {
        log.verbose('PuppetWeb', 'watchDog() saveSession(%s) after %d minutes', this.session, Math.floor(SAVE_SESSION_INTERVAL/1000/60))
        this.browser.saveSession(this.session)
      }
      this.watchDogLastSaveSession = Date.now()
    }

    /**
     * if web browser stay at login qrcode page long time,
     * sometimes the qrcode will not refresh, leave there expired.
     * so we need to refresh the page after a while
     */
    if (type === 'scan') { // watchDog was feed a 'scan' data
      log.verbose('PuppetWeb', 'watchDog() got a food with type scan')
      this.lastScanEventTime = Date.now()
    }
    if (!this.logined()) {
      const scanTimeout = 10 * 60 * 1000 // 10 mins
      if (!this.lastScanEventTime) { // 1st scan event
        this.lastScanEventTime = Date.now()
      }

      if (Date.now() - this.lastScanEventTime > scanTimeout) {
        log.warn('PuppetWeb', 'watchDog() refresh browser for no food of type scan after %s mins', Math.floor(scanTimeout/1000/60))
        this.watchDogLastRefresh = Date.now()
        // fix the problem here
        this.browser.refresh()
      }
    } else if (this.lastScanEventTime) {
      this.lastScanEventTime = null
    }
  }

  watchDogReset(timeout) {
    log.warn('PuppetWeb', 'watchDogReset() timeout %d', timeout)
    const e = new Error('watchdog reset after ' + Math.floor(timeout/1000) + ' seconds')
    this.emit('error', e)
    return Event.onBrowserDead.call(this, e)
  }

  self(message) {
    if (!this.userId) {
      log.verbose('PuppetWeb', 'self() got no this.userId')
      return false
    }
    if (!message || !message.id) {
      log.verbose('PuppetWeb', 'self() got no message')
      return false
    }
    return this.userId == message.get('from')
  }
  send(message) {
    const to      = message.get('to')
    const room    = message.get('room')

    let content     = message.get('content')

    let destination = to
    if (room) {
      destination = room
      // if (to && to!==room) {
      //   content = `@[${to}] ${content}`
      // }
    }

    log.silly('PuppetWeb', `send(${destination}, ${content})`)
    return this.bridge.send(destination, content)
    .catch(e => {
      log.error('PuppetWeb', 'send() exception: %s', e.message)
      throw e
    })
  }
  reply(message, replyContent) {
    if (message.self()) {
      return Promise.reject(new Error('will not to reply message of myself'))
    }

    const m = new Message()
    .set('content'  , replyContent)

    .set('from'     , message.obj.to)
    .set('to'       , message.obj.from)
    .set('room'     , message.obj.room)

    if (this.userId) {
      // FIXME: find a alternate way to check a message create by `self`
      m.set('self', this.userId)
    }
    else {
      log.warn('PuppetWeb', 'reply() too early before logined user be set')
    }

    // log.verbose('PuppetWeb', 'reply() by message: %s', util.inspect(m))
    return this.send(m)
    .catch(e => {
      log.error('PuppetWeb', 'reply() exception: %s', e.message)
      throw e
    })
  }

  /**
   * logout from browser, then server will emit `logout` event
   */
  logout() {
    return this.bridge.logout()
    .catch(e => {
      log.error('PuppetWeb', 'logout() exception: %s', e.message)
      throw e
    })
  }

  getContact(id) {
    return this.bridge.getContact(id)
    .catch(e => {
      log.error('PuppetWeb', 'getContact(%d) exception: %s', id, e.message)
      throw e
    })
  }
  logined() { return !!(this.user) }
  ding(data) {
    if (!this.bridge) {
      return Promise.reject(new Error('ding fail: no bridge(yet)!'))
    }
    return this.bridge.ding(data)
    .catch(e => {
      log.warn('PuppetWeb', 'ding(%s) rejected: %s', data, e.message)
      throw e
    })
  }
}

module.exports = PuppetWeb
