import axios from 'axios';
import { useQuarkStore } from '../store/useQuarkStore';

const http = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3000/api',
});

// 请求拦截：自动注入 x-cookie
http.interceptors.request.use((config) => {
    const cookie = localStorage.getItem('quark_cookie');
    if (cookie) {
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
