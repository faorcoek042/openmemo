/**
 * 占位骨架（T-011, oss-scout）—— 实现归 T-021 / T-022。
 * 这里只放一个能证明构建链路打通的最小组件，不做任何 UI 设计。
 */
import { PACKAGE_NAME as MINDMAP_PKG } from '@openmemo/mindmap';
import { PACKAGE_NAME as SHARED_PKG } from '@openmemo/shared';

export default function App() {
  return (
    <main className="p-8 font-sans">
      <h1 className="text-2xl font-bold">OpenMemo</h1>
      <p className="mt-2 text-sm text-gray-600">骨架占位页（T-011）。UI 实现见 T-021 / T-022。</p>
      <ul className="mt-4 list-disc pl-5 text-sm">
        <li>workspace 链接自检：{SHARED_PKG}</li>
        <li>workspace 链接自检：{MINDMAP_PKG}</li>
      </ul>
    </main>
  );
}
