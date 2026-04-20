window.onload = () => {
    requestPersistence();
    AIService.init()
    syncConfigToUI();
    restoreTaskUI();
};

function requestPersistence() {
    const csInterface = new CSInterface();
    const event = new CSEvent("com.adobe.PhotoshopPersistent", "APPLICATION");
    event.extensionId = "com.github.pipeyume.ps_ai_inpaint_plugin"; 
    csInterface.dispatchEvent(event);
}

function syncConfigToUI() {
    const { service_config, inpaint_config } = AIService.config;
    
    // 同步服务配置
    const apiKeyEl = document.getElementById('api-key');
    if (apiKeyEl) apiKeyEl.value = service_config.apiKey;

    // 自动同步重绘配置 (根据 ID 规则: field-{key})
    for (let key in inpaint_config) {
        const el = document.getElementById(`field-${key}`);
        if (!el) continue;
        if (el.type === 'checkbox') {
            el.checked = inpaint_config[key];
        } else {
            el.value = inpaint_config[key];
        }
    }
}

const TaskCache = {
    get() {
        try { 
            return JSON.parse(localStorage.getItem('ai_tasks_cache') || '[]'); 
        } catch (e) { 
            return []; 
        }
    },
    save(tasks) {
        // 最多保留最近的 30 条任务缓存，避免占用过多空间
        localStorage.setItem('ai_tasks_cache', JSON.stringify(tasks.slice(0, 30)));
    },
    updateTask(taskId, data) {
        let tasks = this.get();
        let task = tasks.find(t => t.taskId === taskId);
        if (!task) {
            task = { taskId, text: "准备中...", state: "running", previews: [] };
            tasks.unshift(task); // 新任务插到最前面
        }
        Object.assign(task, data);
        this.save(tasks);
    },
    addPreview(taskId, preview) {
        let tasks = this.get();
        let task = tasks.find(t => t.taskId === taskId);
        if (task) {
            task.previews = task.previews || [];
            task.previews.push(preview);
            this.save(tasks);
        }
    },
    removeByState(state) {
        let tasks = this.get();
        tasks = tasks.filter(t => t.state !== state);
        this.save(tasks);
    }
};

// --- 新增：页面加载时恢复历史任务 UI ---
function restoreTaskUI() {
    let tasks = TaskCache.get();
    let updated = false;
    
    // 反向遍历渲染，因为 createTaskUI 总是插入到顶部
    tasks.slice().reverse().forEach(task => {
        // 如果上次关闭插件时任务还在"运行中"，将其标记为意外终止
        if (task.state === 'running' || task.state === '') {
            task.state = 'error';
            task.text = '任务意外终止 (插件被关闭)';
            updated = true;
        }
        
        // 传入 isRestore = true 避免恢复时再次写入缓存
        createTaskUI(task.taskId, true);
        updateTaskStatus(task.taskId, task.text, task.state, true);
        
        if (task.previews) {
            task.previews.forEach(p => {
                addPreviewButton(task.taskId, p.index, p.beforeImg, p.afterImg, true);
            });
        }
    });
    
    // 更新因意外终止而改变的状态
    if (updated) TaskCache.save(tasks);
}

document.getElementById('btnDebugClose').onclick = () => {
    cs.closeExtension();
};

document.getElementById('btnSave').onclick = () => {
    const currentInpaint = AIService.config.inpaint_config;
    const newInpaint = {};

    // 动态获取 UI 上的值
    for (let key in currentInpaint) {
        const el = document.getElementById(`field-${key}`);
        if (!el) continue;
        newInpaint[key] = (el.type === 'checkbox') ? el.checked : 
                         (el.type === 'number' ? parseFloat(el.value) : el.value);
    }

    const updates = {
        service_config: {
            ...AIService.config.service_config,
            apiKey: document.getElementById('api-key').value
        },
        inpaint_config: newInpaint
    };

    AIService.saveConfig(updates);
    alert("配置已保存");
};

document.getElementById('btnReset').onclick = () => {
    if (confirm("确定要恢复默认重绘参数吗？")) {
        AIService.resetInpaintConfig();
        syncConfigToUI();
    }
};

document.getElementById('btnToggleSettings').onclick = () => {
    const p = document.getElementById('setting-panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
};

document.getElementById('btnOpenTemp').onclick = () => {
    const script = `
        var f = new Folder(Folder.temp + "/com.github.pipeyume.ps_ai_inpaint_plugin/");
        if (!f.exists) f.create(); 
        f.execute();
    `;
    cs.evalScript(script);
};

document.getElementById('btnOpenConfig').onclick = () => {
    const script = `
        var f = new Folder("${configDirPath}");
        if (!f.exists) f.create();
        f.execute();
    `;
    cs.evalScript(script);
};

function generateUUID() {
    return Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
}

const AbortedTasks = {}

const AppLock = {
    isLocked: false,
    lock() {
        this.isLocked = true;
        const btn = document.getElementById('btnRunInpaint');
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
        btn.innerText = "⏳ 任务执行中...";
    },
    unlock() {
        this.isLocked = false;
        const btn = document.getElementById('btnRunInpaint');
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        btn.innerText = "🚀 执行重绘任务";
    }
};

/**
 * 创建并获取任务 UI 元素
 */
function createTaskUI(taskId, isRestore = false) {
    const taskList = document.getElementById('taskList');
    const taskEl = document.createElement('div');
    taskEl.id = `task-${taskId}`;
    taskEl.className = 'task-item';
    taskEl.innerHTML = `
        <div class="task-id">任务 ID: ${taskId}</div>
        <div class="task-status">准备中...</div>
        <button id="btnTerminate" class="btn-terminate" data-id="${taskId}">🗑️</button>
    `;
    taskEl.querySelector('#btnTerminate').onclick = () => {
        if (confirm("确定要强制停止当前任务吗？")) {
            AIService.terminate();
            AbortedTasks[taskId] = true;
            updateTaskStatus(taskId, "正在强制终止...", "error");
            AppLock.unlock();
        }
    };

    taskList.insertBefore(taskEl, taskList.firstChild);

    // 同步到缓存
    if (!isRestore) {
        TaskCache.updateTask(taskId, { text: "准备中...", state: "running" });
    }

    return taskEl;
}

/**
 * 更新指定任务的状态文本
 */
function updateTaskStatus(taskId, text, state = "running", isRestore = false) {
    const taskEl = document.getElementById(`task-${taskId}`);
    if (!taskEl) return;
    
    const statusEl = taskEl.querySelector('.task-status');
    statusEl.innerText = text;

    if (state === "success" || state === "error") {
        taskEl.classList.add('status-' + state, 'is-done');
        const btn = taskEl.querySelector('.btn-terminate');
        if (btn) btn.style.display = 'none';
    }

    // 同步到缓存
    if (!isRestore) {
        TaskCache.updateTask(taskId, { text, state });
    }
}

document.getElementById('btnClearCompleted').onclick = () => {
    const doneTasks = document.querySelectorAll('.status-success');
    doneTasks.forEach(el => el.remove());
    TaskCache.removeByState('success'); // 清理缓存
};

document.getElementById('btnClearError').onclick = () => {
    const doneTasks = document.querySelectorAll('.status-error');
    doneTasks.forEach(el => el.remove());
    TaskCache.removeByState('error'); // 清理缓存
};

// 核心执行逻辑
document.getElementById('btnRunInpaint').onclick = async () => {
    if (AppLock.isLocked) {
        return;
    }
    const taskId = generateUUID();
    // 获取用户选择的连续生成次数
    const genCountEl = document.querySelector('input[name="genCount"]:checked');
    const genCount = genCountEl ? parseInt(genCountEl.value) : 1;

    createTaskUI(taskId);
    
    const checkAborted = () => {
        return AbortedTasks[taskId] === true;
    };

    if (AIService.isBusy) {
        updateTaskStatus(taskId, "当前有任务正在进行", "error");
        return;
    }

    // 上锁
    AppLock.lock();
    
    try {
        const [tw, th] = AIService.config.inpaint_config.resolution.split('x').map(Number);
        // --------------------------------------------------------
        // 步骤 1: 截取画布
        // --------------------------------------------------------
        updateTaskStatus(taskId, "正在截取画布...");
        
        const exportResult = await new Promise((resolve, reject) => {
            cs.evalScript(`exportInpaintAssets(${tw}, ${th}, "${taskId}")`, (res) => {
                if (res.startsWith("ERR")) {
                    reject(new Error("终止: " + res));
                } else {
                    resolve(res);
                }
            });
        });

        // 检查点 1 
        if (checkAborted()) throw new Error("任务已被强制终止");
        
        const [imgPath, maskPath, cropX, cropY, docId] = exportResult.split('|');

        // --------------------------------------------------------
        // 步骤 2: 读取并处理蒙版
        // --------------------------------------------------------
        updateTaskStatus(taskId, "处理蒙版...");
        const rawImgB64 = window.cep.fs.readFile(imgPath, window.cep.encoding.Base64).data;
        const rawMaskB64 = window.cep.fs.readFile(maskPath, window.cep.encoding.Base64).data;
        
        // 直接在插件侧完成 8x8 处理
        const processedMaskB64 = await ImageProcessor.processMask(rawMaskB64, tw, th);
        
        // 检查点 2
        if (checkAborted()) throw new Error("任务已被强制终止");
        
        window.cep.fs.writeFile(maskPath, processedMaskB64, window.cep.encoding.Base64);
        
        const payload = {
            "image": rawImgB64,
            "mask": processedMaskB64,
        };

        // --------------------------------------------------------
        // 步骤 3: 循环请求 API 并回填
        // --------------------------------------------------------
        for (let i = 0; i < genCount; i++) {
            // 检查点 3
            if (checkAborted()) throw new Error("任务已被强制终止");
            
            const progressPrefix = genCount > 1 ? `[${i + 1}/${genCount}] ` : "";
            
            // API 冷却检查
            if (i > 0) {
                const cooldown = AIService.config.service_config.cooldownMs || 20000;
                const elapsed = Date.now() - AIService.config.service_config.lastRequestTime;
                
                if (elapsed < cooldown) {
                    const waitTimeMs = cooldown - elapsed;
                    let remainingSec = Math.ceil(waitTimeMs / 1000);
                    while (remainingSec > 0) {
                        if (checkAborted()) throw new Error("任务已被强制终止");
                        updateTaskStatus(taskId, `${progressPrefix}API 冷却中，等待 ${remainingSec} 秒...`);
                        await new Promise(r => setTimeout(r, 1000));
                        remainingSec--;
                    }
                }
            }

            // 调用 API 服务
            const responseB64 = await AIService.inpaint(payload, (msg) => {
                updateTaskStatus(taskId, `${progressPrefix}${msg}`);
            });
            
            // 检查点 4
            if (checkAborted()) throw new Error("任务已被强制终止");
            
            // 写入结果文件
            updateTaskStatus(taskId, "正在回填到 Photoshop...");
            const outPath = imgPath.replace('img_', `out_${i}_`);
            window.cep.fs.writeFile(outPath, responseB64, window.cep.encoding.Base64);
            const safeOutPath = outPath.replace(/\\/g, '/');
            const safeMaskPath = maskPath.replace(/\\/g, '/');

            // 回填到 PS (使用 Promise 封装，保留 50ms 延时防拥堵)
            await new Promise((resolve, reject) => {
                setTimeout(() => {
                    cs.evalScript(`importAiResult("${safeOutPath}", "${safeMaskPath}", ${cropX}, ${cropY}, ${docId}, "${taskId}_${i+1}")`, (res) => {
                        if (res === "SUCCESS") {
                            addPreviewButton(taskId, i + 1, imgPath, outPath);
                            resolve();
                        } else {
                            reject(new Error("PS回填失败: " + res)); 
                        }
                    });
                }, 50); 
            });
        }
        
        // 全部完成
        updateTaskStatus(taskId, "任务完成！ ✅", "success");

    } catch (err) {
        // 统一捕获所有 throw 出来的错误 (包括截取失败、回填失败、手动终止等)
        updateTaskStatus(taskId, err.message, "error");
    } finally {
        // 无论成功还是失败，都会走到这里执行解锁操作，防止由于死锁导致按钮永远灰显
        AppLock.unlock();
    }
};

function addPreviewButton(taskId, index, beforeImg, afterImg, isRestore = false) {
    const taskEl = document.getElementById(`task-${taskId}`);
    if (!taskEl) return;

    let btnGroup = taskEl.querySelector('.preview-btn-group');
    if (!btnGroup) {
        btnGroup = document.createElement('div');
        btnGroup.className = 'preview-btn-group';
        taskEl.appendChild(btnGroup);
    }

    const btn = document.createElement('button');
    btn.className = 'btn-preview-mini';
    btn.innerText = `对比 #${index}`;
    btn.onclick = () => openComparison(beforeImg, afterImg);
    btnGroup.appendChild(btn);

    // 同步到缓存
    if (!isRestore) {
        TaskCache.addPreview(taskId, { index, beforeImg, afterImg });
    }
}

function openComparison(beforePath, afterPath) {
    const overlay = document.getElementById('previewOverlay');
    const imgBefore = document.getElementById('imgBefore');
    const imgAfter = document.getElementById('imgAfter');
    const sliderRange = document.getElementById('sliderRange');
    const sliderLine = document.getElementById('sliderLine');

    // 解决 PS 缓存，添加时间戳
    const v = `?v=${Date.now()}`;
    imgBefore.src = 'file:///' + beforePath.replace(/\\/g, '/') + v;
    imgAfter.src = 'file:///' + afterPath.replace(/\\/g, '/') + v;

    // 滑块拖动事件
    sliderRange.oninput = (e) => {
        const val = e.target.value; // val: 0 到 100
        // inset(top right bottom left); 
        // 右边裁剪量 = 100% - 滑块当前百分比
        imgAfter.style.clipPath = `inset(0 ${100 - val}% 0 0)`;
        sliderLine.style.left = `${val}%`;
    };
    
    // 每次打开都复位到 50%
    imgAfter.style.clipPath = `inset(0 50% 0 0)`;
    sliderLine.style.left = `50%`;
    sliderRange.value = 50;

    overlay.style.display = 'flex';
}

function closePreview() {
    document.getElementById('previewOverlay').style.display = 'none';
}