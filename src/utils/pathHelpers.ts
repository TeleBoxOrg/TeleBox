import fs from "fs";
import path from "path";

const ASSETS_PATH = path.join(process.cwd(), "assets");
const TEMP_PATH = path.join(process.cwd(), "temp");

function createDirectoryInDirectory(name: string, basePath: string): string {
    const filePath = path.join(basePath, name);
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(filePath, { recursive: true });
        return filePath;
    }
    return filePath;
}

/**
 * 在 assets 目录下创建一个子目录。
 * 如果目录已存在，则直接返回其路径。
 *
 * @param name - 要创建的子目录名称
 * @returns 返回创建或已存在的子目录完整路径
 */
function createDirectoryInAssets(name: string): string {
    return createDirectoryInDirectory(name, ASSETS_PATH);
}

/**
 * 在临时目录下创建一个子目录。
 * 如果目录已存在，则直接返回其路径。
 *
 * @param name - 要创建的子目录名称
 * @returns 返回创建或已存在的子目录完整路径
 */
function createDirectoryInTemp(name: string): string {
    return createDirectoryInDirectory(name, TEMP_PATH);
}

export {createDirectoryInAssets, createDirectoryInTemp};