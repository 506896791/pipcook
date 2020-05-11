import * as uuid from 'uuid';
import path from 'path';
import { ensureDir, ensureSymlink, remove } from 'fs-extra';
import { fork, ChildProcess } from 'child_process';
import { PluginProto, PluginOperator, PluginMessage, PluginResponse } from './proto';
import { CostaRuntime, PluginPackage } from './index';
import Debug from 'debug';
const debug = Debug('costa.runnable');

/**
 * Returns when called `start()`
 */
class RunnableResponse implements PluginResponse {
  public id: string;
  public __flag__ = '__pipcook_plugin_runnable_result__';
  constructor(id: string) {
    this.id = id;
  }
}

/**
 * The arguments for calling `bootstrap`.
 */
interface BootstrapArg {
  /**
   * Add extra environment variables.
   */
  customEnv?: Record<string, string>;
}

/**
 * The runnable is to represent a container to run plugins.
 */
export class PluginRunnable {
  private id: string = uuid.v4();
  private rt: CostaRuntime;
  private handle: ChildProcess = null;

  // private events
  private onread: Function | null;
  private ondestroyed: Function | null;

  /**
   * the current working directory for this runnable.
   */
  public workingDir: string;

  /**
   * The current state.
   */
  public state: 'init' | 'idle' | 'busy';

  /**
   * Create a runnable by the given runtime.
   * @param rt the costa runtime.
   */
  constructor(rt: CostaRuntime) {
    this.rt = rt;
    this.workingDir = path.join(this.rt.options.componentDir, this.id);
    this.state = 'init';
  }
  /**
   * Do bootstrap the runnable client.
   */
  async bootstrap(arg: BootstrapArg): Promise<void> {
    const compPath = this.workingDir;
    await ensureDir(compPath);
    await ensureDir(compPath + '/node_modules');

    debug(`bootstrap a new process for ${this.id}`);
    this.handle = fork(__dirname + '/client', [], {
      stdio: 'inherit',
      cwd: compPath,
      env: Object.assign({}, process.env, arg.customEnv)
    });
    this.handle.on('message', this.handleMessage.bind(this));
    this.handle.once('disconnect', this.afterDestroy.bind(this));

    // send the first message as handshaking with client
    const ret = await this.handshake();
    if (!ret) {
      throw new TypeError(`created runnable "${this.id}" failed.`);
    }
    this.state = 'idle';
  }
  /**
   * Get the runnable value for the given response.
   * @param resp the value to the response.
   */
  async valueOf(resp: RunnableResponse): Promise<object> {
    const msg = await this.sendAndWait(PluginOperator.READ, {
      event: 'deserialize response',
      params: [
        resp
      ]
    });
    if (!msg.params || msg.params.length !== 1) {
      throw new TypeError('invalid response because the params is invalid.');
    }
    return JSON.parse(msg.params[0]);
  }
  /**
   * Do start from a specific plugin.
   * @param name the plguin name.
   */
  async start(pkg: PluginPackage, ...args: any[]): Promise<RunnableResponse | null> {
    if (this.state !== 'idle') {
      throw new TypeError(`the runnable "${this.id}" is busy or not ready now`);
    }
    this.state = 'busy';

    const { installDir, componentDir } = this.rt.options;
    const compPath = path.join(componentDir, this.id);
    const nameSchema = path.parse(pkg.name);

    await ensureDir(compPath);
    await ensureDir(compPath + '/node_modules');
    if (nameSchema.dir) {
      await ensureDir(compPath + `/node_modules/${nameSchema.dir}`);
    }

    // prepare boa and miniconda environment
    await ensureSymlink(
      path.join(installDir, 'node_modules', pkg.name),
      compPath + `/node_modules/${pkg.name}`);

    const resp = await this.sendAndWait(PluginOperator.WRITE, {
      event: 'start',
      params: [
        pkg,
        ...args
      ]
    });
    this.state = 'idle';

    // return if the result id is provided.
    const id = resp.params[0];
    return id ? new RunnableResponse(id) : null;
  }
  /**
   * Destroy this runnable, this will kill process, and get notified on `afterDestory()`. 
   */
  async destroy(): Promise<void> {
    this.send(PluginOperator.WRITE, { event: 'destroy' });
    return new Promise((resolve) => {
      this.ondestroyed = resolve;
    });
  }
  /**
   * Send a message with operator.
   * @param op 
   * @param msg 
   */
  private send(op: PluginOperator, msg?: PluginMessage): boolean {
    const data = PluginProto.stringify(op, msg);
    return this.handle.send(data);
  }
  /**
   * Reads the message, it's blocking the async context util.
   */
  private async read(): Promise<PluginProto> {
    return new Promise((resolve) => {
      this.onread = resolve;
    });
  }
  /**
   * Do send handshake message to runnable client, and wait for response.
   */
  private async handshake(): Promise<boolean> {
    await this.sendAndWait(PluginOperator.START, {
      event: 'handshake',
      params: [ this.id ]
    });
    return true;
  }
  /**
   * Wait for the next operator util receiving.
   * @param op operator to wait.
   */
  private async waitOn(op: PluginOperator): Promise<PluginMessage> {
    let cur, msg;
    do {
      const data = await this.read();
      cur = data.op;
      msg = data.message;
    } while (cur !== op);
    return msg;
  }
  /**
   * Send an operator with message, and waits for the response.
   * @param op 
   * @param msg 
   */
  private async sendAndWait(op: PluginOperator, msg: PluginMessage) {
    this.send(op, msg);
    debug(`sent ${msg.event} for ${this.id}, and wait for response`);

    const resp = await this.waitOn(op);
    if (resp.event !== 'pong') {
      throw new TypeError('invalid response because the event is not "pong".');
    }
    return resp;
  }
  /**
   * handle the messages from peer client.
   * @param msg 
   */
  private handleMessage(msg: string) {
    const proto = PluginProto.parse(msg) as PluginProto;
    if (typeof this.onread === 'function') {
      this.onread(proto);
    }
  }
  /**
   * Fired when the peer client is exited.
   */
  private async afterDestroy(): Promise<void> {
    debug(`the runnable(${this.id}) has been destroyed.`);
    await remove(path.join(this.rt.options.componentDir, this.id));
    if (typeof this.ondestroyed === 'function') {
      this.ondestroyed();
    }
  }
}