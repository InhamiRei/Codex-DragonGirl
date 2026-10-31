import { happySparkles } from '../shared/expression.js';

// 只生成虹膜内的流动高光，直接混合进原眼区纹理，不创建嘴巴、腮红或其他脸部图层。
export class EyeSparkles {
  // 每只眼睛复用一块离屏画布和输出缓存，动画过程中不反复创建纹理。
  constructor(eye, width, height, index) {
    Object.assign(this, { eye, width, height, index });
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.output = new Uint8ClampedArray(width * height * 4);
  }

  // 用眼球内缘与斜眼睑共同裁剪，星光和柔光都不会涂到眼眶、头发或脸上。
  clipIris() {
    const context = this.context, iris = this.eye.iris;
    context.beginPath();
    context.ellipse(iris.cx, iris.cy, iris.rx, iris.ry, 0, 0, Math.PI * 2);
    context.clip();
    const left = iris.cx - iris.rx - 1, right = iris.cx + iris.rx + 1;
    context.beginPath();
    context.moveTo(left, iris.lid + (left - iris.cx) * iris.slope);
    context.lineTo(right, iris.lid + (right - iris.cx) * iris.slope);
    context.lineTo(right, iris.cy + iris.ry + 1);
    context.lineTo(left, iris.cy + iris.ry + 1);
    context.closePath();
    context.clip();
  }

  // 加宽四角星的中心并保留紫色细边，避免小尺寸下与原画的圆高光融成一团。
  star(x, y, radius, angle, alpha) {
    const context = this.context;
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    const halo = context.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius * 1.4);
    halo.addColorStop(0, `rgba(218, 174, 255, ${alpha * 0.20})`);
    halo.addColorStop(1, 'rgba(218, 174, 255, 0)');
    context.fillStyle = halo;
    context.fillRect(-radius * 2, -radius * 2, radius * 4, radius * 4);
    context.beginPath();
    context.moveTo(0, -radius * 1.12);
    context.quadraticCurveTo(radius * 0.30, -radius * 0.30, radius, 0);
    context.quadraticCurveTo(radius * 0.30, radius * 0.30, 0, radius * 1.12);
    context.quadraticCurveTo(-radius * 0.30, radius * 0.30, -radius, 0);
    context.quadraticCurveTo(-radius * 0.30, -radius * 0.30, 0, -radius * 1.12);
    context.strokeStyle = `rgba(137, 88, 184, ${alpha * 0.80})`;
    context.lineWidth = radius * 0.14;
    context.stroke();
    context.fillStyle = `rgba(255, 253, 255, ${alpha})`;
    context.fill();
    context.restore();
  }

  // 原画保持不变，只有被裁剪在虹膜里的光会缓慢移动、明暗变化和掠过。
  illuminate(source, amount, elapsed) {
    const context = this.context, { eye, width, height } = this;
    const iris = eye.iris;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.save();
    context.scale(width / eye.width, height / eye.height);
    context.translate(-eye.x, -eye.y);
    this.clipIris();
    const light = context.createRadialGradient(iris.cx, iris.cy + iris.ry * 0.45, 2, iris.cx, iris.cy, iris.ry * 1.4);
    light.addColorStop(0, `rgba(221, 170, 255, ${amount * 0.10})`);
    light.addColorStop(1, 'rgba(221, 170, 255, 0)');
    context.fillStyle = light;
    context.fillRect(iris.cx - iris.rx, iris.cy - iris.ry, iris.rx * 2, iris.ry * 2);

    // 一道很淡的流光从眼内掠过，与星芒不同步，避免像整张图片在平移。
    const sweepX = iris.cx + iris.rx * (-1.35 + (elapsed % 2000) / 2000 * 2.7);
    const sweep = context.createLinearGradient(sweepX - 18, 0, sweepX + 18, 0);
    sweep.addColorStop(0, 'rgba(255, 245, 255, 0)');
    sweep.addColorStop(0.5, `rgba(255, 245, 255, ${amount * 0.08})`);
    sweep.addColorStop(1, 'rgba(255, 245, 255, 0)');
    context.fillStyle = sweep;
    context.fillRect(sweepX - 18, iris.cy - iris.ry, 36, iris.ry * 2);

    for (const particle of happySparkles(elapsed, this.index)) {
      const x = iris.cx + particle.x * iris.rx, y = iris.cy + particle.y * iris.ry;
      const radius = particle.radius * Math.min(iris.rx, iris.ry);
      const alpha = amount * particle.alpha;
      if (particle.kind === 'star') this.star(x, y, radius, particle.angle, alpha);
      else {
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = `rgba(255, 246, 255, ${alpha})`;
        context.fill();
      }
    }
    context.restore();
    const glow = context.getImageData(0, 0, width, height).data;
    // 先合成为眼部纹理再交给原来的视线和眨眼变换，高光始终跟着眼球并受眼皮遮挡。
    for (let index = 0; index < source.length; index += 4) {
      const alpha = glow[index + 3] / 255;
      for (let channel = 0; channel < 3; channel += 1)
        this.output[index + channel] = source[index + channel] * (1 - alpha) + glow[index + channel] * alpha;
      this.output[index + 3] = source[index + 3];
    }
    return this.output;
  }
}
