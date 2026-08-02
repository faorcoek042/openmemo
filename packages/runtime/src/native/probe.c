/*
 * openmemo-probe — the authoritative hardware/backend probe.
 *
 * WHY THIS EXISTS (R-02 §A.0, ADR-003 decision 3):
 *   File-existence checks are NOT evidence of a usable device. Two reverse-examples
 *   were found empirically on the T-012 Linux box:
 *     1. `libvulkan.so.1` and `libOpenCL.so.1` were both installed on a machine with
 *        no GPU at all (no /dev/dri, empty /sys/class/drm).
 *     2. After installing `vulkan-tools`, Mesa's lavapipe ICD appeared and Vulkan
 *        began reporting ONE physical device — `llvmpipe`, deviceType
 *        VK_PHYSICAL_DEVICE_TYPE_CPU. A naive "devices > 0" test would have happily
 *        installed the Vulkan backend and then software-rasterised every matmul.
 *   Therefore the only trustworthy answer comes from actually loading the ggml
 *   backends and enumerating devices *with their type*, which is what this does.
 *
 * WHY A SEPARATE PROCESS:
 *   Measured on the T-012 box: with zero CPU backend .so files present, whisper.cpp
 *   calls ggml_abort() inside ggml_backend_dev_backend_reg() and the process dies with
 *   SIGABRT (exit 134). GPU driver faults behave the same way. An in-process N-API
 *   binding would take the daemon down with it. This binary is spawned, watchdogged
 *   and reaped by packages/runtime/src/probe/runProbe.ts.
 *
 * CONTRACT: prints a single JSON object to stdout, exits 0. All ggml logging is
 * redirected to stderr so stdout stays machine-parseable.
 *
 * Build: see scripts/build-probe.sh (links only ggml-base + ggml; the backend .so
 * files are dlopen'd at runtime by ggml_backend_load_all_from_path).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ggml.h"
#include "ggml-backend.h"

#define OPENMEMO_PROBE_SCHEMA 1

/* Route ggml's own chatter to stderr; stdout must contain only our JSON. */
static void probe_log_cb(enum ggml_log_level level, const char * text, void * user_data) {
    (void) level;
    (void) user_data;
    fputs(text, stderr);
}

static const char * dev_type_str(enum ggml_backend_dev_type t) {
    switch (t) {
        case GGML_BACKEND_DEVICE_TYPE_CPU:   return "cpu";
        case GGML_BACKEND_DEVICE_TYPE_GPU:   return "gpu";
        case GGML_BACKEND_DEVICE_TYPE_IGPU:  return "igpu";
        case GGML_BACKEND_DEVICE_TYPE_ACCEL: return "accel";
        case GGML_BACKEND_DEVICE_TYPE_META:  return "meta";
        default:                             return "unknown";
    }
}

/*
 * Heuristic: is this "GPU" actually a software rasteriser?
 *
 * Mesa lavapipe/llvmpipe and Google SwiftShader both present as real Vulkan devices.
 * lavapipe self-reports deviceType CPU (so the type check catches it), but SwiftShader
 * has been observed reporting other types, and driver stacks vary. Name matching is a
 * cheap second line of defence. Marked in the output rather than filtered out, so the
 * daemon decides policy and the UI can explain itself.
 */
static int looks_like_software_renderer(const char * name, const char * desc) {
    static const char * needles[] = {
        "llvmpipe", "lavapipe", "swiftshader", "softpipe", "basic render driver", "warp", NULL
    };
    char hay[1024];
    snprintf(hay, sizeof(hay), "%s %s", name ? name : "", desc ? desc : "");
    for (char * p = hay; *p; ++p) {
        if (*p >= 'A' && *p <= 'Z') *p = (char) (*p - 'A' + 'a');
    }
    for (int i = 0; needles[i]; ++i) {
        if (strstr(hay, needles[i])) return 1;
    }
    return 0;
}

static void json_puts_escaped(const char * s) {
    putchar('"');
    for (const unsigned char * p = (const unsigned char *) (s ? s : ""); *p; ++p) {
        switch (*p) {
            case '"':  fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\n': fputs("\\n",  stdout); break;
            case '\r': fputs("\\r",  stdout); break;
            case '\t': fputs("\\t",  stdout); break;
            default:
                if (*p < 0x20) printf("\\u%04x", *p);
                else putchar(*p);
        }
    }
    putchar('"');
}

int main(int argc, char ** argv) {
    const char * backend_dir = (argc > 1) ? argv[1] : NULL;

    ggml_log_set(probe_log_cb, NULL);

    /*
     * Scans `backend_dir` (or, when NULL, the executable's directory + cwd) for
     * ggml-<name>-<variant>.so|dll|dylib, calls ggml_backend_score() on each and keeps
     * the best. Backends that fail to dlopen — missing libcuda.so.1, wrong ISA, a
     * corrupt file — are skipped silently. Verified on the T-012 box: dropping a
     * 200 KB random-bytes file named libggml-cpu-evilcorp.so changed nothing.
     */
    if (backend_dir && backend_dir[0]) {
        ggml_backend_load_all_from_path(backend_dir);
    } else {
        ggml_backend_load_all();
    }

    const size_t n = ggml_backend_dev_count();

    printf("{\n");
    printf("  \"schemaVersion\": %d,\n", OPENMEMO_PROBE_SCHEMA);
    printf("  \"ggmlVersion\": ");
    json_puts_escaped(ggml_version());
    printf(",\n");
    printf("  \"ggmlCommit\": ");
    json_puts_escaped(ggml_commit());
    printf(",\n");
    printf("  \"searchPath\": ");
    json_puts_escaped(backend_dir ? backend_dir : "");
    printf(",\n");
    printf("  \"deviceCount\": %zu,\n", n);
    printf("  \"devices\": [\n");

    for (size_t i = 0; i < n; ++i) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);

        const char * name = ggml_backend_dev_name(dev);
        const char * desc = ggml_backend_dev_description(dev);
        enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);

        size_t mem_free = 0, mem_total = 0;
        ggml_backend_dev_memory(dev, &mem_free, &mem_total);

        ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
        const char * reg_name = reg ? ggml_backend_reg_name(reg) : "";

        printf("    {\n");
        printf("      \"index\": %zu,\n", i);
        printf("      \"name\": ");        json_puts_escaped(name);     printf(",\n");
        printf("      \"description\": "); json_puts_escaped(desc);     printf(",\n");
        printf("      \"backendReg\": ");  json_puts_escaped(reg_name); printf(",\n");
        printf("      \"type\": ");        json_puts_escaped(dev_type_str(type)); printf(",\n");
        printf("      \"memFreeBytes\": %zu,\n",  mem_free);
        printf("      \"memTotalBytes\": %zu,\n", mem_total);
        printf("      \"softwareRenderer\": %s\n",
               looks_like_software_renderer(name, desc) ? "true" : "false");
        printf("    }%s\n", (i + 1 < n) ? "," : "");
    }

    printf("  ]\n");
    printf("}\n");

    fflush(stdout);
    return 0;
}
