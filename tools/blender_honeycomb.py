"""Blender 5.2：蜂巢小块 + 满格蜂蜜 + 溢出蜜滴。

用法：
  blender -b -P tools/blender_honeycomb.py -- --out <png> --res 768 --samples 32
"""

from __future__ import annotations

import argparse
import math
import sys

import bmesh
import bpy
from mathutils import Vector

R = 1.0
WALL = 0.18
DEPTH = 0.34
NEIGHBORS = [
    (0.0, 0.0),
    (math.sqrt(3) * R, 0.0),
    (math.sqrt(3) * R / 2, 1.5 * R),
    (-math.sqrt(3) * R / 2, 1.5 * R),
    (-math.sqrt(3) * R, 0.0),
    (-math.sqrt(3) * R / 2, -1.5 * R),
    (math.sqrt(3) * R / 2, -1.5 * R),
]


def clear() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material_gold():
    mat = bpy.data.materials.new("CellGold")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (1.0, 0.60, 0.10, 1)
    bsdf.inputs["Metallic"].default_value = 0.65
    bsdf.inputs["Roughness"].default_value = 0.28
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.25
    return mat


def material_honey():
    mat = bpy.data.materials.new("Honey")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (1.0, 0.52, 0.06, 1)
    bsdf.inputs["Roughness"].default_value = 0.16
    bsdf.inputs["IOR"].default_value = 1.45
    bsdf.inputs["Transmission Weight"].default_value = 0.0
    if "Subsurface Weight" in bsdf.inputs:
        bsdf.inputs["Subsurface Weight"].default_value = 0.35
        bsdf.inputs["Subsurface Radius"].default_value = (0.35, 0.16, 0.04)
        bsdf.inputs["Subsurface Scale"].default_value = 0.25
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.75
        bsdf.inputs["Coat Roughness"].default_value = 0.025

    absorb = nodes.new("ShaderNodeVolumeAbsorption")
    absorb.inputs["Color"].default_value = (0.78, 0.25, 0.01, 1)
    absorb.inputs["Density"].default_value = 0.30
    out = nodes["Material Output"]
    links.new(absorb.outputs["Volume"], out.inputs["Volume"])
    return mat


def add_ring(name: str, cx: float, cz: float, gold) -> None:
    verts = []
    for y in (-DEPTH / 2, DEPTH / 2):
        for radius in (R, R - WALL):
            for i in range(6):
                angle = math.radians(30 + i * 60)
                verts.append((cx + radius * math.cos(angle), y, cz + radius * math.sin(angle)))
    faces = []
    for i in range(6):
        n = (i + 1) % 6
        faces.append((i, n, 6 + n, 6 + i))                 # front ring
        faces.append((12 + n, 12 + i, 18 + i, 18 + n))     # back ring
        faces.append((i, 12 + i, 12 + n, n))               # outer side
        faces.append((6 + n, 18 + n, 18 + i, 6 + i))       # inner side
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(gold)
    bevel = obj.modifiers.new("Bevel", "BEVEL")
    bevel.width = 0.018
    bevel.segments = 2
    bevel.limit_method = "ANGLE"
    obj.modifiers.new("WeightedNormal", "WEIGHTED_NORMAL")


def add_honey():
    honey = material_honey()

    def smooth(obj):
        for poly in obj.data.polygons:
            poly.use_smooth = True

    def add_mesh(name, verts, faces):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.data.materials.append(honey)
        smooth(obj)
        return obj

    # 每个房室一块蜂蜜：六边形薄片，填满房室
    for i, (cx, cz) in enumerate(NEIGHBORS):
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=6, radius=R - WALL + 0.03, depth=0.12,
            location=(cx, 0.0, cz),
            rotation=(math.radians(90), 0, math.radians(30)),
        )
        obj = bpy.context.object
        obj.name = f"Honey{i}"
        obj.data.materials.append(honey)
        bevel = obj.modifiers.new("Bevel", "BEVEL")
        bevel.width = 0.018
        bevel.segments = 2
        bpy.ops.object.shade_smooth()

    # 底部溢出的蜂蜜团
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=48, ring_count=24, radius=1.0,
        location=(0.0, -0.20, -1.42),
    )
    pool = bpy.context.object
    pool.name = "Overflow"
    pool.scale = (1.30, 0.14, 0.34)
    bpy.ops.object.shade_smooth()
    pool.data.materials.append(honey)

    # 底部蜜滴：锥形主体 + 末端圆珠
    bpy.ops.mesh.primitive_cone_add(
        vertices=32, radius1=0.09, radius2=0.30, depth=1.10,
        location=(0.0, -0.16, -2.10),
    )
    drip = bpy.context.object
    drip.name = "Drip"
    bpy.ops.object.shade_smooth()
    drip.data.materials.append(honey)

    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=32, ring_count=16, radius=0.24,
        location=(0.0, -0.14, -2.86),
    )
    drop = bpy.context.object
    drop.name = "Drop"
    drop.scale = (1.0, 0.85, 1.15)
    bpy.ops.object.shade_smooth()
    drop.data.materials.append(honey)


def add_lights() -> None:
    def area(name, loc, energy, size, color):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = loc
        direction = Vector((0, 0, -0.3)) - Vector(loc)
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        return obj

    area("Key", (-4.5, -7.5, 5.5), 700, 9.0, (1.0, 0.86, 0.66))
    area("Fill", (5.0, -6.0, 1.0), 260, 8.0, (0.72, 0.82, 1.0))
    area("Rim", (0.0, -4.0, -5.0), 500, 8.0, (1.0, 0.62, 0.28))
    area("Top", (0.0, -2.0, 6.0), 400, 6.0, (1.0, 0.9, 0.75))


def setup_render(res: int, samples: int) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 12
    scene.cycles.transmission_bounces = 12
    scene.cycles.transparent_max_bounces = 12
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.2

    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.05, 0.055, 0.07, 1)
    bg.inputs["Strength"].default_value = 1.8
    scene.world = world

    camera_data = bpy.data.cameras.new("Camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 7.8
    camera = bpy.data.objects.new("Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (0, -12, 0.7)
    target = Vector((0, 0, -0.9))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera


def main() -> None:
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--res", type=int, default=768)
    parser.add_argument("--samples", type=int, default=32)
    args = parser.parse_args(argv)

    clear()
    gold = material_gold()
    for i, (cx, cz) in enumerate(NEIGHBORS):
        add_ring(f"Cell{i}", cx, cz, gold)
    add_honey()
    add_lights()
    setup_render(args.res, args.samples)
    bpy.context.scene.render.filepath = args.out
    bpy.ops.render.render(write_still=True)
    print(f"rendered {args.out}")


if __name__ == "__main__":
    main()
