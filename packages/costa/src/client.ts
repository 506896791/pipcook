import * as uuid from 'uuid';
import { PluginProto, PluginOperator } from './proto';
import { PluginPackage } from './index';
import Debug from 'debug';

type MessageHandler = Record<PluginOperator, (proto: PluginProto) => void>;
const debug = Debug('costa.client');

function recv(respOp: PluginOperator, ...params: string[]) {
  process.send(PluginProto.stringify(respOp, {
    event: 'pong',
    params
  }));
}

let clientId: string;
let previousResults: Record<string, any> = {};

function deserializeArg(arg: Record<string, any>) {
  if (arg.__flag__ === '__pipcook_plugin_runnable_result__' &&
    previousResults[arg.id]) {
    return previousResults[arg.id];
  }
  return arg;
}

const handlers: MessageHandler = {
  [PluginOperator.START]: (proto: PluginProto) => {
    if (proto.message.event === 'handshake' &&
      typeof proto.message.params[0] === 'string') {
      clientId = proto.message.params[0];
      recv(PluginOperator.START, clientId);
    }
  },
  [PluginOperator.WRITE]: async (proto: PluginProto) => {
    const { event, params } = proto.message;
    debug(`receive an event ${event}`);
    if (event === 'start') {
      const pkg = params[0] as PluginPackage;
      const [ , ...pluginArgs ] = params;
      debug(`start loading plugin ${pkg.name}`);

      try {
        const boa = require('@pipcook/boa');
        if (pkg.pipcook?.target.PYTHONPATH) {
          boa.setenv(pkg.pipcook.target.PYTHONPATH);
          debug('setup boa environment');
        }
        let fn = require(pkg.name);
        if (fn && typeof fn !== 'function' && typeof fn.default === 'function') {
          fn = fn.default;
        }
        const resp = await fn(...pluginArgs.map(deserializeArg));
        if (resp) {
          const rid = uuid.v4();
          previousResults[rid] = resp;
          debug(`create a result "${rid}" for plugin "${pkg.name}@${pkg.version}"`);
          recv(PluginOperator.WRITE, rid);
        } else {
          recv(PluginOperator.WRITE);
        }
      } catch (err) {
        console.error(`occurring an error: ${err?.stack}`);
      }
    } else if (event === 'destroy') {
      debug('stop the plugin.');
      process.exit(0);
    }
  },
  [PluginOperator.READ]: (proto: PluginProto) => {
    // TODO
  },
  [PluginOperator.COMPILE]: (proto: PluginProto) => {
    // TODO
  }
};

process.on('message', (msg) => {
  const proto = PluginProto.parse(msg) as PluginProto;
  handlers[proto.op](proto);
});
