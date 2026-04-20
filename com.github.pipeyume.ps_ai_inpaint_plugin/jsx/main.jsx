/* target photoshop */

function exportInpaintAssets(targetW, targetH, taskId) {
    // 保存并设置单位为像素，防止计算偏差
    var oldUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    var result;
    app.activeDocument.suspendHistory("Export Inpaint Assets", "result = performExport(" + targetW + "," + targetH + ",'" + taskId + "');");

    //恢复单位
    app.preferences.rulerUnits = oldUnits;
    return result;
}
    

/**
 * 核心导出逻辑
 * @param {Number} targetW 目标宽度
 * @param {Number} targetH 目标高度
 * @param {taskId} taskId 任务标识符
 */
function performExport(targetW, targetH, taskId) {
    // --- 1. 基础状态检查 ---
    if (app.documents.length === 0) {
        alert("错误：没有打开的文档！");
        return "ERR_NO_DOC";
    }

    var doc = app.activeDocument;
    // 如果文档本身就比目标尺寸小，报错
    if (doc.width.value < targetW || doc.height.value < targetH) {
        alert("错误：文档尺寸 (" + doc.width.value + "x" + doc.height.value + ") 小于目标尺寸 (" + targetW + "x" + targetH + ")");
        return "ERR_DOC_TOO_SMALL";
    }

    var layer = doc.activeLayer;

    if (!layer || layer.typename !== "ArtLayer") {
        alert("错误：请先选中一个有效的图层！");
        return "ERR_NO_LAYER";
    }

    // --- 2. 选区检查与坐标计算 ---
    var selBounds;
    try {
        selBounds = doc.selection.bounds; // [左, 上, 右, 下]
    } catch (e) {
        alert("错误：未检测到选区！");
        return "ERR_NO_SELECTION";
    }
    
    // --- 校验选区是否超过图层边界 ---
    var layerBounds = layer.bounds; // [左, 上, 右, 下]
    // 获取图层边界数值
    var layerLeft = layerBounds[0].value;
    var layerTop = layerBounds[1].value;
    var layerRight = layerBounds[2].value;
    var layerBottom = layerBounds[3].value;
    var layerW = layerRight - layerLeft;
    var layerH = layerBottom - layerTop;
    if (layerW < targetW || layerH < targetH) {
        alert("错误：图层内容尺寸 (" + Math.round(layerW) + "x" + Math.round(layerH) + ") 小于目标尺寸 (" + targetW + "x" + targetH + ")，无法截取！");
        return "ERR_LAYER_TOO_SMALL";
    }

    if (
        selBounds[0].value < layerLeft || // 选区左侧超出图层左侧
        selBounds[1].value < layerTop || // 选区顶部超出图层顶部
        selBounds[2].value > layerRight || // 选区右侧超出图层右侧
        selBounds[3].value > layerBottom    // 选区底部超出图层底部
    ) {
        alert("错误：当前选区超出了选中图层 (" + layer.name + ") 的内容边界！\n请确保选区完全包含在图层像素范围内。");
        return "ERR_SELECTION_OUT_OF_LAYER";
    }

    // 选区尺寸校验逻辑
    var selW = selBounds[2].value - selBounds[0].value;
    var selH = selBounds[3].value - selBounds[1].value;

    if (selW > targetW || selH > targetH) {
        alert("错误：当前选区尺寸 (" + Math.round(selW) + "x" + Math.round(selH) + ") 超过了设定的目标分辨率 (" + targetW + "x" + targetH + ")。\n请缩小选区或调高分辨率，否则图像会被截断。");
        return "ERR_SELECTION_TOO_LARGE";
    }

    // 计算选区中心点
    var selCenterX = (selBounds[0].value + selBounds[2].value) / 2;
    var selCenterY = (selBounds[1].value + selBounds[3].value) / 2;

    // --- 3. 计算截取区域 (以选区为中心) ---
    // 计算理想的左上角坐标
    var cropX = selCenterX - (targetW / 2);
    var cropY = selCenterY - (targetH / 2);

    

    // 边界约束：确保截取区域不超出文档边界
    if (cropX < layerLeft) cropX = layerLeft;
    if (cropY < layerTop) cropY = layerTop;
    if (cropX + targetW > layerRight) cropX = layerRight - targetW;
    if (cropY + targetH > layerBottom) cropY = layerBottom - targetH;

    try {
        var tempFolder = new Folder(Folder.temp + "/com.github.pipeyume.ps_ai_inpaint_plugin");
        if (!tempFolder.exists) tempFolder.create();
        
        var imgF = new File(tempFolder + "/img_" + taskId + ".png");
        var maskF = new File(tempFolder + "/mask_" + taskId + ".png");

        var white = new SolidColor(); white.rgb.hexValue = "FFFFFF";
        var black = new SolidColor(); black.rgb.hexValue = "000000";

        // 在原文档新建临时层填充蒙版像素（解决套索形状问题）
        var maskTempLayer = doc.artLayers.add();
        doc.selection.fill(white);   // 填充背景色 (白色)
        doc.selection.invert();     // 反选
        doc.selection.fill(black);   // 填充外部 (黑色)

        // 创建临时文档截取目标区域
        // 截取范围坐标 [左, 上, 右, 下]
        var captureRegion = [
            [cropX, cropY],
            [cropX + targetW, cropY],
            [cropX + targetW, cropY + targetH],
            [cropX, cropY + targetH]
        ];

        var tempDoc = app.documents.add(targetW, targetH, 72, "AI_Temp", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        var pngOpt = new PNGSaveOptions();

        app.activeDocument = doc;
        doc.selection.select(captureRegion);
        doc.activeLayer = maskTempLayer;
        doc.selection.copy();

        app.activeDocument = tempDoc;
        var pastedMask = tempDoc.paste();
        tempDoc.saveAs(maskF, pngOpt, true);

        app.activeDocument = doc;
        maskTempLayer.visible = false; // 隐藏蒙版层
        doc.activeLayer = layer;
        var duplicatedLayer = layer.duplicate(tempDoc, ElementPlacement.PLACEATBEGINNING);
        
        app.activeDocument = tempDoc;
        pastedMask.visible = false;
        duplicatedLayer.translate(-cropX, -cropY);
        tempDoc.saveAs(imgF, pngOpt, true);

        tempDoc.close(SaveOptions.DONOTSAVECHANGES);
        maskTempLayer.remove();
        doc.selection.deselect();
        // 返回路径和截取时的起始坐标，用于最后回填
        return imgF.fsName + "|" + maskF.fsName + "|" + cropX + "|" + cropY + "|" + doc.id;
    } catch (err) {
        return "ERR_SYSTEM:" + err.toString();
    }
}

function importAiResult(filePath, maskPath, targetX, targetY, targetDocId, taskId) {
    // 保存并设置单位为像素，防止计算偏差
    var oldUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    var result;
    var targetDoc = null;
    for (var i = 0; i < app.documents.length; i++) {
        if (app.documents[i].id == targetDocId) {
            targetDoc = app.documents[i];
            break;
        }
    }
    if (targetDoc) {
        app.activeDocument = targetDoc;
        targetDoc.suspendHistory("Import AI Result", 
            "result = performImportLogic('" + filePath + "','" + maskPath + "'," + targetX + "," + targetY + "," + targetDocId + ",'" + taskId + "');"
        );
    } else {
        result = "ERR_DOC_CLOSED";
    }

    app.preferences.rulerUnits = oldUnits;
    return result;
}

/**
 * 结果导入逻辑
 * @param {String} filePath 重绘结果路径
 * @param {String} maskPath 蒙版路径
 * @param {Number} targetX 目标X坐标
 * @param {Number} targetY 目标Y坐标
 * @param {Number} targetDocId 原始文档ID
 * @param {Number} taskId 任务ID
 */
/**
 * 结果导入逻辑
 * @param {String} filePath 重绘结果路径
 * @param {String} maskPath 蒙版路径
 * @param {Number} targetX 目标X坐标
 * @param {Number} targetY 目标Y坐标
 * @param {Number} targetDocId 原始文档ID
 * @param {Number} taskId 任务ID
 */
function performImportLogic(filePath, maskPath, targetX, targetY, targetDocId, taskId) {
    try {
        var targetDoc = null;
        for (var i = 0; i < app.documents.length; i++) {
            if (app.documents[i].id == targetDocId) {
                targetDoc = app.documents[i];
                break;
            }
        }
        if (!targetDoc) return "ERR_DOC_CLOSED";
        app.activeDocument = targetDoc;
        
        // 用于选中图层
        var originalLayer;
        if (targetDoc.activeLayer) {
            originalLayer = targetDoc.activeLayer;
        }

        var group;
        try {
            group = targetDoc.layerSets.getByName("ai_generated");
        } catch (e) {
            group = targetDoc.layerSets.add();
            group.name = "ai_generated";
        }
        // 用于AI层恢复可见性
        var group_visible = group.visible;

        var resFile = new File(filePath);
        if (!resFile.exists) return "ERR_FILE_NOT_FOUND";
        
        // 在干净的独立文档中处理蒙版与裁剪
        var resDoc = app.open(resFile);
        
        // 将背景图层转换为普通图层以支持透明度（否则 clear() 会填充背景色而不是变透明）
        if (resDoc.activeLayer.isBackgroundLayer) {
            resDoc.activeLayer.isBackgroundLayer = false;
        }
        var aiBaseLayer = resDoc.activeLayer;

        var maskFile = new File(maskPath);
        if (maskFile.exists) {
            var mDoc = app.open(maskFile);
            mDoc.selection.selectAll();
            mDoc.selection.copy();
            mDoc.close(SaveOptions.DONOTSAVECHANGES);

            app.activeDocument = resDoc;
            var pastedMask = resDoc.paste(); 
            
            resDoc.selection.load(resDoc.channels[0], SelectionType.REPLACE);
            // 焦点切回底部的 AI 图层进行透明裁剪
            resDoc.activeLayer = aiBaseLayer; 
            resDoc.selection.invert();    // 反选（选中蒙版外的部分）
            resDoc.selection.clear();     // 删除非蒙版区域的像素，使其变透明
            resDoc.selection.deselect();
            
            // 移除用完的蒙版临时层
            pastedMask.remove();
        }

        // --- 记录裁剪后非透明像素在临时文档中的相对偏移 ---
        var localOffsetX = 0;
        var localOffsetY = 0;
        var isEmpty = false;
        try {
            // 获取裁剪后剩余像素的真实边界
            localOffsetX = resDoc.activeLayer.bounds[0].value;
            localOffsetY = resDoc.activeLayer.bounds[1].value;
        } catch(e) {
            // 如果内容全被清空（比如由于极端情况蒙版全黑），获取 bounds 会抛出异常
            isEmpty = true;
        }

        if (isEmpty) {
            resDoc.close(SaveOptions.DONOTSAVECHANGES);
            return "SUCCESS"; // 无需回填，直接成功返回
        }

        // 全选并复制
        resDoc.selection.selectAll();
        resDoc.selection.copy();
        resDoc.close(SaveOptions.DONOTSAVECHANGES);

        // ==========================================
        // 回到目标文档进行简单的坐标回填
        // ==========================================
        app.activeDocument = targetDoc;
        targetDoc.activeLayer = group;
        var aiLayer = targetDoc.paste();
        aiLayer.name = taskId;
        
        // --- 计算最终需要移动到的绝对坐标 ---
        // 目标绝对位置 = 原始截图左上角 (targetX) + 裁剪后在选区内的局部偏移 (localOffsetX)
        var destX = targetX + localOffsetX;
        var destY = targetY + localOffsetY;
        // 移动 AI 图层到正确坐标
        aiLayer.translate(destX - aiLayer.bounds[0].value, destY - aiLayer.bounds[1].value);

        // 恢复AI层可见性
        group.visible = group_visible;
        // 恢复选中图层
        if(originalLayer){
            targetDoc.activeLayer = originalLayer;
        }

        return "SUCCESS";
    } catch (e) {        
        return "ERR_IMPORT:" + e.toString();
    }
}