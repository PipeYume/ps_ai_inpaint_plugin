const cs = new CSInterface();
const configDirPath = (cs.getSystemPath(SystemPath.USER_DATA) + "/com.github.pipeyume.ps_ai_inpaint_plugin").replace(/\\/g, '/');
const configPath = configDirPath + "/config.json"

/**
 * AI 服务封装
 */
const AIService = {
    _defaultInpaintConfig: null,
    isBusy: false, // 并发锁：保证 1 个任务/用户
    abortController: null, // 取消内部服务请求

    config: {
        service_config: {
            apiKey: "",
            baseUrl: "https://api.idlecloud.cc/api",
            cooldownMs: 20000,
            lastRequestTime: 0
        },
        inpaint_config: {
            model: "nai-diffusion-4-5-full",
            positivePrompt: "",
            negativePrompt: "",
            resolution: "1024x1024",
            steps: 23,
            scale: 5.5,
            sampler: "k_euler",
            noise_schedule: "karras",
            qualityToggle: false,
            ucPreset: 1,
            inpaint_strength: 1.0,
            disabled_original_image: true,
            color_correct: true
        }
    },

    init() {
        if(this._defaultInpaintConfig === null){
            this._defaultInpaintConfig = Object.freeze(JSON.parse(JSON.stringify(this.config.inpaint_config)));
        }
        this.loadConfig()
    },

    loadConfig() {
        const result = window.cep.fs.readFile(configPath);
        if (result.err === window.cep.fs.NO_ERROR) {
            try {
                const saved = JSON.parse(result.data);
                this.config = { ...this.config, ...saved };
            } catch (e) { 
                alert("本地配置文件解析失败: " + e); 
            }
        } else {
            window.cep.fs.makedir(configDirPath); 
            this.saveConfig({});
        }
    },

    saveConfig(newFields) {
        const default_inpaint_config = this._defaultInpaintConfig || {};
        const updated_service = {
            ...this.config.service_config,
            ...(newFields.service_config || {})
        };
        const update_inpaint = {
            ...default_inpaint_config,
            ...this.config.inpaint_config,
            ...(newFields.inpaint_config || {})
        };

        this.config = {
            service_config: updated_service,
            inpaint_config: update_inpaint
        };
        const writeResult = window.cep.fs.writeFile(configPath, JSON.stringify(this.config, null, 2));
        if (writeResult.err !== window.cep.fs.NO_ERROR) {
            alert("配置保存失败，错误码:", writeResult.err);
        }
    },

    resetInpaintConfig() {
        if (this._defaultInpaintConfig) {
            this.config.inpaint_config = Object.freeze(JSON.parse(JSON.stringify(this._defaultInpaintConfig)));
        }
    },

    terminate(){
        if (this.abortController) {
            this.abortController.abort();
        }
    },

    /**
     * 执行重绘任务
     * @param {Object} payload 包含 image, mask
     * @param {Function} onProgress 用于更新 UI 状态信息的回调函数
     */
    async inpaint(payload, onProgress) {
        // 检查并发锁
        if (this.isBusy) throw new Error("当前有任务正在进行...");

        try {
            this.isBusy = true;
            this.abortController = new AbortController();
            const { signal } = this.abortController;

            // 冷却逻辑
            const now = Date.now();
            const elapsed = now - this.config.service_config.lastRequestTime;
            if (elapsed < this.config.service_config.cooldownMs) {
                const waitTime = Math.ceil((this.config.service_config.cooldownMs - elapsed) / 1000);
                throw new Error(`API 冷却中，请在 ${waitTime} 秒后重试。`);
            }

            const headers = {
                "Authorization": `Bearer ${this.config.service_config.apiKey}`,
                "Content-Type": "application/json"
            };

            const resString = this.config.inpaint_config.resolution || "1024x1024";
            const [w, h] = resString.split('x').map(Number);

            const full_payload = {
                ...this.config.inpaint_config,
                width: w,
                height: h,
                action: true,
                image: payload.image,
                mask: payload.mask
            };

            delete full_payload.resolution;

            // 执行请求：提交任务
            onProgress("正在提交任务...");
            const submitRes = await fetch(`${this.config.service_config.baseUrl}/generate_image`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(full_payload),
                signal: signal
            });

            if (submitRes.status !== 200) {
                const errorRaw = await submitRes.text();
                const errorObj = JSON.parse(errorRaw);
                throw new Error(`提交失败: ${JSON.stringify(errorObj)}`);
            }

            const submitData = await submitRes.json();
            const jobId = submitData.job_id;
            if (!jobId) throw new Error("未获取到 Job ID");

            let max_retries = 60
            // 轮询获取结果
            for (let i = 0; i < max_retries; i++) {
                await new Promise(r => setTimeout(r, 5000));

                const resultRes = await fetch(`${this.config.service_config.baseUrl}/get_result/${jobId}`, { 
                    headers,
                    signal: signal
                });
                
                if (resultRes.status !== 200) {
                    const errorDetail = await resultRes.text();
                    onProgress(`获取结果失败 (${resultRes.status} ${resultRes.statusText}): ${errorDetail}`);
                    break;
                }

                const resultData = await resultRes.json();
                const status = resultData.status;

                onProgress(`[轮询${i+1}/${max_retries}] 任务状态: ${status}`);

                if (status === "completed") {
                    this.config.service_config.lastRequestTime = Date.now();
                    const imageUrl = resultData.image_url;
                    
                    if (imageUrl) {
                        onProgress("正在下载结果...");
                        return await this._downloadAsBase64(imageUrl);
                    } else {
                        throw new Error("任务完成但未返回图片数据。");
                    }
                } 
                else if (status === "failed") {
                    this.config.service_config.lastRequestTime = Date.now();
                    throw new Error(`任务失败: ${resultData.error || '未知错误'}`);
                }
            }

            throw new Error("任务超时");

        } catch (e) {
            if (e.name === 'AbortError' || e.message === "任务已手动终止") {
                console.log("用户取消了任务");
                throw new Error("任务已中止");
            }
            this.config.service_config.lastRequestTime = Date.now();
            throw e;
        } finally {
            this.isBusy = false;
            this.abortController = null;
        }
    },

    /**
     * 辅助函数：下载图片
     */
    async _downloadAsBase64(url) {
        const resp = await fetch(url);
        if (resp.status !== 200) throw new Error(`下载失败: ${resp.status}`);
        const blob = await resp.blob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
        });
    }
};