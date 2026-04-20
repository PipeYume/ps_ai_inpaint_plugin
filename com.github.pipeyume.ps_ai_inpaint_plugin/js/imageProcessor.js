const ImageProcessor = {
    /**
     * 严格对齐 Python process_mask_logic 的逻辑
     */
    async processMask(maskB64, width, height) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');

                // 1. 尺寸校验与缩放 (对应 Image.Resampling.NEAREST)
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(img, 0, 0, width, height);

                const imgData = ctx.getImageData(0, 0, width, height);
                const data = imgData.data;
                
                // 准备输出用的 Canvas
                const outCanvas = document.createElement('canvas');
                outCanvas.width = width;
                outCanvas.height = height;
                const outCtx = outCanvas.getContext('2d');
                outCtx.fillStyle = "black";
                outCtx.fillRect(0, 0, width, height);
                outCtx.fillStyle = "white";

                const gridW = Math.ceil(width / 8);
                const gridH = Math.ceil(height / 8);
                const activeGrids = []; // 存储 (gy, gx)

                // 2. 8x8 网格量化 (找出哪些格子有白色像素)
                for (let gy = 0; gy < gridH; gy++) {
                    for (let gx = 0; gx < gridW; gx++) {
                        let hasWhite = false;
                        
                        // 检查 8x8 区域
                        for (let py = 0; py < 8; py++) {
                            for (let px = 0; px < 8; px++) {
                                const x = gx * 8 + px;
                                const y = gy * 8 + py;
                                if (x < width && y < height) {
                                    const idx = (y * width + x) * 4;
                                    // 对应 Python 的二值化 (mask_array > 127)
                                    if (data[idx] > 127) { 
                                        hasWhite = true; 
                                        break; 
                                    }
                                }
                            }
                            if (hasWhite) break;
                        }

                        if (hasWhite) {
                            // 对应 Python: aligned_mask[y_s:y_e, x_s:x_e] = 255
                            outCtx.fillRect(gx * 8, gy * 8, 8, 8);
                            activeGrids.push([gy, gx]);
                        }
                    }
                }

                // 3. 满足 32 + 8*n 的最低尺寸限制 (4x4 网格单位)
                if (activeGrids.length > 0) {
                    const gys = activeGrids.map(g => g[0]);
                    const gxs = activeGrids.map(g => g[1]);
                    
                    const gy_min = Math.min(...gys);
                    const gy_max = Math.max(...gys);
                    const gx_min = Math.min(...gxs);
                    const gx_max = Math.max(...gxs);

                    const gh = gy_max - gy_min + 1;
                    const gw = gx_max - gx_min + 1;

                    if (gh < 4 || gw < 4) {
                        const target_gh = Math.max(4, gh);
                        const target_gw = Math.max(4, gw);

                        const pad_h = target_gh - gh;
                        const pad_w = target_gw - gw;

                        // 向四周扩充网格索引 (new_gy_min = max(0, gy_min - pad_h // 2))
                        let new_gy_min = Math.max(0, gy_min - Math.floor(pad_h / 2));
                        let new_gy_max = Math.min(gridH - 1, new_gy_min + target_gh - 1);
                        let new_gx_min = Math.max(0, gx_min - Math.floor(pad_w / 2));
                        let new_gx_max = Math.min(gridW - 1, new_gx_min + target_gw - 1);

                        // 重新修正起始点以保证长度 (new_gy_min = max(0, new_gy_max - target_gh + 1))
                        new_gy_min = Math.max(0, new_gy_max - target_gh + 1);
                        new_gx_min = Math.max(0, new_gx_max - target_gw + 1);

                        // 在 aligned_mask 上填补扩充后的区域 (注意：矩形填充需包含边界)
                        const fillX = new_gx_min * 8;
                        const fillY = new_gy_min * 8;
                        const fillW = (new_gx_max - new_gx_min + 1) * 8;
                        const fillH = (new_gy_max - new_gy_min + 1) * 8;
                        
                        outCtx.fillRect(fillX, fillY, fillW, fillH);
                    }
                }

                // 返回 Base64
                resolve(outCanvas.toDataURL("image/png").split(',')[1]);
            };
            img.src = "data:image/png;base64," + maskB64;
        });
    }
};