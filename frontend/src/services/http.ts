import axios from 'axios';
import { useQuarkStore } from '../store/useQuarkStore';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3000/api';

const http = axios.create({
    baseURL: API_BASE_URL,
});

// 内嵌服务身份校验：后端固定监听 127.0.0.1:3000。如果这个端口被别的本地程序
// 抢先占用，直接发请求就等于把登录 Cookie（含 __puus 会话令牌）交给那个程序，
// 所以第一次带 Cookie 的请求之前，先探测 /health 确认对方确实是本应用的内嵌服务。
let serverVerified = false;
let verificationInFlight: Promise<boolean> | null = null;

const verifyLocalServer = (): Promise<boolean> => {
    if (serverVerified) return Promise.resolve(true);
    if (verificationInFlight) return verificationInFlight;

    verificationInFlight = (async () => {
        // 应用刚启动时后端可能还没开始监听，连接失败要重试；
        // 只有"确认是本服务"才缓存成功，失败不缓存，下次请求会重新探测。
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const res = await axios.get<{ service?: string }>(`${API_BASE_URL}/health`, {
                    timeout: 5000,
                });
                if (res.data?.service === 'quark-api-rust') {
                    serverVerified = true;
                    return true;
                }
                // 端口被其它服务占用：对方明确不是本应用，重试也没有意义
                return false;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
            }
        }
        return false;
    })().finally(() => {
        verificationInFlight = null;
    });

    return verificationInFlight;
};

// 请求拦截：先确认服务身份，再注入 x-cookie
http.interceptors.request.use(async (config) => {
    if (!(await verifyLocalServer())) {
        // 这里不弹 toast：每个请求都会走到这里，会刷屏；交给调用方按普通错误展示
        throw new Error(
            '本地接口服务不可用（127.0.0.1:3000 可能被其它程序占用）。' +
            '为避免登录凭证外泄，已拒绝发送请求，请关闭占用该端口的程序后重启本应用。'
        );
    }

    const cookie = localStorage.getItem('quark_cookie');
    // 调用方显式传入 x-cookie 时不覆盖（登录校验要用"待验证的 Cookie"，而不是已保存的那个）
    if (cookie && !config.headers['x-cookie']) {
        config.headers['x-cookie'] = cookie;
    }
    return config;
});

// 响应拦截：处理 x-append-cookie（__puus 会轮换，必须用新值覆盖旧值）
http.interceptors.response.use((response) => {
    const rawAppendCookie: unknown = response.headers['x-append-cookie'];
    const appendCookie = Array.isArray(rawAppendCookie) ? rawAppendCookie.join(';') : rawAppendCookie;
    if (typeof appendCookie === 'string' && appendCookie) {
        // 后端下发形如 "__puus=xxxx" 的键值对；空值（__puus=）代表删除 Cookie，直接忽略
        const matched = appendCookie.match(/__puus=([^;,\s]*)/);
        const puusValue = matched?.[1] ?? '';
        if (puusValue) {
            const newPair = `__puus=${puusValue}`;
            const currentCookie = localStorage.getItem('quark_cookie') || '';
            const newCookie = currentCookie.includes('__puus=')
                ? currentCookie.replace(/__puus=[^;]*/, newPair)
                : (currentCookie ? `${currentCookie}; ${newPair}` : newPair);
            localStorage.setItem('quark_cookie', newCookie);
            // 同步更新 Zustand store，确保下载等功能能拿到完整 Cookie
            useQuarkStore.getState().setCookie(newCookie);
            console.log('[HTTP] Updated __puus cookie');
        }
    }
    return response;
});

export default http;
