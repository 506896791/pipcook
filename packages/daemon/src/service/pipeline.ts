import { provide, inject } from 'midway';
import { PipelineDB, constants, PipelineStatus, EvaluateResult } from '@pipcook/pipcook-core';
import * as path from 'path';
import * as validate from 'uuid-validate';
import * as fs from 'fs-extra';
import { v1 as uuidv1 } from 'uuid';

import { RunParams } from '../interface';
import { retriveLog } from '../runner/helper';
import { PipelineModel, PipelineModelStatic } from '../model/pipeline';
import { JobModelStatic, JobModel } from '../model/job';
import PluginRuntime from '../boot/plugin';
import { RunnableResponse } from '@pipcook/costa/dist/runnable';
import { exec, ExecOptions, ExecException } from 'child_process';
import { PluginPackage } from '@pipcook/costa/dist';

const { PIPCOOK_LOGS } = constants;
type QueryParams = { id: string, name?: string } | { id?: string, name: string };

function getIdOrName(id: string): QueryParams {
  if (!id) {
    throw new Error('id or name cannot be empty');
  }
  return validate(id) as boolean ? { id } : { name: id };
}

function execAsync(cmd: string, opts: ExecOptions): Promise<string> {
  return new Promise((resolve, reject): void => {
    exec(cmd, opts, (err: ExecException, stdout: string, stderr: string) => {
      err == null ? resolve(stdout) : reject(err);
    });
  });
};

@provide('pipelineService')
export class PipelineService {

  @inject('pipelineModel')
  model: PipelineModelStatic;

  @inject('jobModel')
  job: JobModelStatic;

  @inject('pluginRT')
  pluginRT: PluginRuntime;

  initPipeline(config: PipelineDB): Promise<PipelineModel> {
    return this.model.create(config);
  }

  async getPipelineById(id: string): Promise<PipelineModel> {
    return this.model.findOne({
      where: getIdOrName(id)
    });
  }

  async getPipelines(offset: number, limit: number): Promise<{rows: PipelineModel[], count: number}> {
    return this.model.findAndCountAll({
      offset,
      limit,
      order: [
        [ 'createdAt', 'DESC' ]
      ]
    });
  }

  async deletePipelineById(id: string): Promise<void> {
    await this.model.destroy({
      where: getIdOrName(id)
    });
  }

  async updatePipelineById(id: string, config: PipelineDB): Promise<PipelineModel> {
    await this.model.update(config, {
      where: getIdOrName(id)
    });
    return this.getPipelineById(id);
  }

  async getJobById(id: string): Promise<JobModel> {
    return this.job.findOne({
      where: { id }
    });
  }

  async getJobsByPipelineId(id: string, offset: number, limit: number): Promise<{rows: JobModel[], count: number}> {
    const pipelineId = await this.getPipelineId(id);
    return this.job.findAndCountAll({
      offset,
      limit,
      where: {
        pipelineId
      },
      order: [
        ['createdAt', 'DESC']
      ]
    });
  }

  async getJobs(offset: number, limit: number): Promise<{rows: JobModel[], count: number}> {
    return this.job.findAndCountAll({
      offset,
      limit,
      order: [
        [ 'createdAt', 'DESC' ]
      ]
    });
  }

  async updateJobById(id: string, data: RunParams): Promise<JobModel> {
    await this.job.update(data, {
      where: { id }
    });
    return this.getJobById(id);
  }

  async createJob(id: string): Promise<JobModel> {
    const pipelineId = await this.getPipelineId(id);
    const specVersion = (await fs.readJSON(path.join(__dirname, '../../package.json'))).version;
    const job = await this.job.create({
      id: uuidv1(),
      pipelineId,
      specVersion,
      status: PipelineStatus.INIT,
      currentIndex: -1
    });
    await fs.ensureFile(path.join(PIPCOOK_LOGS, job.id, 'stderr'));
    await fs.ensureFile(path.join(PIPCOOK_LOGS, job.id, 'stdout'));
    return job;
  }

  async startJob(job: JobModel, cwd: string) {
    const { costa } = this.pluginRT;
    const pipeline = await this.getPipelineById(job.pipelineId);
    const runable = await costa.createRunnable();
    const getParams = (params: string | null, ...extra: object[]): object => {
      if (params == null) {
        return Object.assign({}, ...extra);
      } else {
        return Object.assign(JSON.parse(params), ...extra);
      }
    };
    const verifyPlugin = (name: string): void => {
      if (!pipeline[name]) throw new TypeError(`"${name}" plugin is required`);
    };

    verifyPlugin('dataCollect');
    const dataCollect = await costa.fetchAndInstall(pipeline.dataCollect, cwd);
    const dataDir = path.join(costa.options.datasetDir, `${dataCollect.name}@${dataCollect.version}`);
    const modelPath = path.join(runable.workingDir, 'model');

    // run dataCollect to download dataset.
    await runable.start(dataCollect, getParams(pipeline.dataCollectParams, {
      dataDir
    }));

    verifyPlugin('dataAccess');
    const dataAccess = await costa.fetchAndInstall(pipeline.dataAccess, cwd);
    let dataset = await runable.start(dataAccess, getParams(pipeline.dataAccessParams, {
      dataDir
    }));

    let dataProcess: PluginPackage;
    if (pipeline.dataProcess) {
      dataProcess = await costa.fetchAndInstall(pipeline.dataProcess, cwd);
      dataset = await runable.start(dataProcess, getParams(pipeline.dataProcessParams));
    }

    // verify the model related plugins are used.
    verifyPlugin('modelDefine');
    verifyPlugin('modelTrain');
    verifyPlugin('modelEvaluate');

    // start defining/training/evaluating model
    let model: RunnableResponse;
    const modelDefine = await costa.fetchAndInstall(pipeline.modelDefine, cwd);
    model = await runable.start(modelDefine, dataset, getParams(pipeline.modelDefineParams));

    const modelTrain = await costa.fetchAndInstall(pipeline.modelTrain, cwd);
    model = await runable.start(modelTrain, dataset, model, getParams(pipeline.modelTrainParams, {
      modelPath
    }));

    const modelEvaluate = await costa.fetchAndInstall(pipeline.modelEvaluate, cwd);
    const output = await runable.start(modelEvaluate, dataset, model, getParams(pipeline.modelEvaluateParams, {
      modelDir: modelPath
    }));

    const result = await runable.valueOf(output) as EvaluateResult;
    job.evaluateMap = JSON.stringify(result);
    job.evaluatePass = result.pass;
    job.endTime = Date.now();
    await job.save();

    // start generates the output directory
    const dist = path.join(cwd, 'output');
    await fs.remove(dist);
    await fs.ensureDir(dist);
    await execAsync('npm init -y', { cwd: dist });

    // post processing the package.json
    const projPackage = await fs.readJSON(dist + '/package.json');
    projPackage.dependencies = {
      [modelDefine.name]: modelDefine.version,
    };
    if (dataProcess) {
      projPackage.dependencies[dataProcess.name] = dataProcess.version;
    }

    const jsonWriteOpts = { spaces: 2 } as fs.WriteOptions;
    const metadata = {
      cwd,
      pipeline: pipeline.toJSON(),
      output: job.toJSON(),
    };

    await [
      fs.copy(modelPath, dist + '/model'),
      fs.copy(path.join(__dirname, '../../assets/predict.js'), dist + '/index.js'),
      fs.outputJSON(dist + '/package.json', projPackage, jsonWriteOpts),
      fs.outputJSON(dist + '/metadata.json', metadata, jsonWriteOpts),
    ];
    await runable.destroy();
    console.log(`trained the model to ${dist}`);
  }

  getLogById(id: string): Promise<string> {
    return retriveLog(id);
  }

  async getPipelineId(id: string): Promise<string> {
    if (validate(id) as boolean) {
      return id;
    }
    const pipeline = await this.getPipelineById(id);
    return pipeline.id;
  }
}
