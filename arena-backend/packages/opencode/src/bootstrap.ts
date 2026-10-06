import { InstanceRuntime } from "./project/instance-runtime"
import { context } from "./project/instance-context"

export async function bootstrap<T>(directory: string, callback: () => Promise<T>) {
  const instance = await InstanceRuntime.load({ directory })
  try {
    return await context.provide(instance, callback)
  } finally {
    await InstanceRuntime.disposeInstance(instance)
  }
}
